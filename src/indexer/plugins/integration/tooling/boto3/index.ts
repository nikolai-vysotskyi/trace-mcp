/**
 * Boto3Plugin — detects AWS boto3 and botocore usage and extracts
 * AWS service and resource call edges (S3, SSM, Glue, Lambda, etc.).
 *
 * Covers:
 *   - Direct `boto3.client("service")`, `boto3.resource("service")`, and `boto3.Session(...)`
 *   - Session-based client/resource creation: `session.client("service")`
 *   - Botocore client creation: `botocore.session.get_session().create_client("service")`
 *   - Statically tracked client variables (module-level, local, and `self.<attr>`)
 *   - Method calls on tracked clients/resources resolving to `aws:<service>:<Operation>`
 *   - Literal resource identifiers (Bucket, Key, Name/Path, JobName, FunctionName, etc.)
 *   - Environment variable names (only the names, never values)
 *   - Strict precision gate: untracked objects calling similar method names do not emit edges.
 */

import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  EdgeTypeDeclaration,
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const KNOWN_PACKAGES = ['boto3', 'botocore'] as const;

// Import detection
const BOTO3_IMPORT_RE =
  /^\s*(?:import\s+(?:boto3|botocore)(?:\s+as\s+\w+)?|from\s+(?:boto3|botocore)(?:\.\w+)?\s+import)\b/m;

// Signals for client / resource / session instantiation
const BOTO3_CLIENT_SIGNAL_RE =
  /\b(?:boto3|\w+)\s*\.\s*(?:client|resource|Session)\s*\(|\bbotocore(?:\.session)?\.(?:get_session\(\)\.)?create_client\s*\(|\b(?:client|resource|Session)\s*\(\s*['"][a-zA-Z0-9_-]+['"]/;

export type AwsOperationType = 'read' | 'write' | 'delete' | 'list';

export interface Boto3ClientBinding {
  variable: string;
  service: string;
  kind: 'client' | 'resource' | 'session';
  region?: string;
  envVars: string[];
}

export interface Boto3CallMatch {
  service: string;
  operation: string;
  method: string;
  op: AwsOperationType;
  clientVar: string;
  bucket?: string;
  key?: string;
  parameter?: string;
  functionName?: string;
  jobName?: string;
  tableName?: string;
  queueUrl?: string;
  queueName?: string;
  secretId?: string;
  resource?: string;
  resourceType?: string;
  envVars: string[];
  index: number;
}

/** Convert a snake_case boto3 method to AWS PascalCase operation name. */
export function toPascalCase(snake: string): string {
  return snake
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** Classify AWS operation kind into read, write, delete, or list. */
export function classifyOperation(method: string): AwsOperationType {
  const m = method.toLowerCase();
  if (m.startsWith('list_') || m === 'list') {
    return 'list';
  }
  if (
    m.startsWith('get_') ||
    m.startsWith('describe_') ||
    m.startsWith('head_') ||
    m.startsWith('download_') ||
    m.startsWith('scan') ||
    m.startsWith('query') ||
    m.startsWith('read_') ||
    m.startsWith('batch_get_') ||
    m.startsWith('select_') ||
    m === 'get'
  ) {
    return 'read';
  }
  if (
    m.startsWith('delete_') ||
    m.startsWith('abort_') ||
    m.startsWith('remove_') ||
    m.startsWith('terminate_') ||
    m.startsWith('purge_') ||
    m === 'delete'
  ) {
    return 'delete';
  }
  return 'write';
}

/** Extract environment variable names referenced via os.getenv / os.environ in a text segment. */
export function extractEnvVarNames(text: string): string[] {
  const names = new Set<string>();
  const re =
    /\bos\s*\.\s*(?:getenv\s*\(\s*|environ\s*\[\s*|environ\s*\.\s*get\s*\(\s*)['"]([A-Z0-9_]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    names.add(match[1]);
  }
  return Array.from(names);
}

/** Extract string literal for a keyword argument like `Bucket='...'`. */
function extractKeywordLiteral(callText: string, kw: string): string | undefined {
  const re = new RegExp(`\\b${kw}\\s*=\\s*(?:[brufBRUF]*['"]([^'"]+)['"])`);
  const m = callText.match(re);
  return m ? m[1] : undefined;
}

/** Find the balanced closing parenthesis from startIndex. */
function findBalancedParens(source: string, openParenIndex: number): number {
  let depth = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = openParenIndex + 1; i < source.length; i++) {
    const ch = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Scan a Python file and discover all client, resource, and session bindings.
 */
export function discoverBindings(source: string): Map<string, Boto3ClientBinding> {
  const bindings = new Map<string, Boto3ClientBinding>();

  // 1. Session variables: `sess = boto3.Session(...)` or `self.sess = boto3.Session(...)`
  const sessionRe =
    /(?:(?:self|cls)\s*\.\s*)?([a-zA-Z_]\w*)\s*=\s*(?:boto3(?:\.session)?|session)?\s*\.\s*Session\s*\(/g;
  let sm: RegExpExecArray | null;
  while ((sm = sessionRe.exec(source)) !== null) {
    const varName = sm[1];
    const openParen = sm.index + sm[0].length - 1;
    const closeParen = findBalancedParens(source, openParen);
    const body = closeParen !== -1 ? source.slice(openParen + 1, closeParen) : '';
    const region = extractKeywordLiteral(body, 'region_name');
    const envVars = extractEnvVarNames(body);
    bindings.set(varName, {
      variable: varName,
      service: '',
      kind: 'session',
      region,
      envVars,
    });
  }

  // 2. Direct client & resource assignments:
  // e.g.:
  // `s3 = boto3.client('s3', ...)`
  // `self.s3_client = boto3.client("s3", ...)`
  // `ssm = session.client('ssm', ...)`
  // `s3 = session.create_client('s3', ...)`
  // `dynamo = boto3.resource('dynamodb', ...)`
  // `client = botocore.session.get_session().create_client('s3')`
  const clientAssignRe =
    /(?:(?:self|cls)\s*\.\s*)?([a-zA-Z_]\w*)\s*=\s*(?:(?:boto3|[a-zA-Z_]\w*)\s*\.\s*(client|resource|create_client)|botocore(?:\.session)?\.(?:get_session\(\)\.)?create_client|(client|resource))\s*\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let cm: RegExpExecArray | null;
  while ((cm = clientAssignRe.exec(source)) !== null) {
    const varName = cm[1];
    const rawKind = cm[2] || cm[3] || 'client';
    const kind = rawKind === 'resource' ? 'resource' : 'client';
    const service = cm[4].toLowerCase();
    const openParen = source.indexOf('(', cm.index);
    let region: string | undefined;
    let envVars: string[] = [];
    if (openParen !== -1) {
      const closeParen = findBalancedParens(source, openParen);
      const body = closeParen !== -1 ? source.slice(openParen + 1, closeParen) : '';
      region = extractKeywordLiteral(body, 'region_name');
      envVars = extractEnvVarNames(body);
    }
    bindings.set(varName, {
      variable: varName,
      service,
      kind,
      region,
      envVars,
    });
  }

  // 3. Sub-resources: e.g. `bucket = s3.Bucket('my-bucket')` or `table = dynamodb.Table('users')`
  for (const [parentVar, parentBinding] of Array.from(bindings.entries())) {
    if (parentBinding.kind === 'resource') {
      const subResRe = new RegExp(
        `(?:(?:self|cls)\\s*\\.\\s*)?([a-zA-Z_]\\w*)\\s*=\\s*(?:(?:self|cls)\\s*\\.\\s*)?${parentVar}\\s*\\.\\s*(Bucket|Table|Queue)\\s*\\(\\s*['"]([^'"]+)['"]`,
        'g',
      );
      let subM: RegExpExecArray | null;
      while ((subM = subResRe.exec(source)) !== null) {
        const subVar = subM[1];
        bindings.set(subVar, {
          variable: subVar,
          service: parentBinding.service,
          kind: 'resource',
          region: parentBinding.region,
          envVars: [subM[3]],
        });
      }
    }
  }

  return bindings;
}

/**
 * Scan a Python file for direct method calls on tracked boto3 clients/resources.
 */
export function extractBoto3Calls(source: string): Boto3CallMatch[] {
  const bindings = discoverBindings(source);
  const calls: Boto3CallMatch[] = [];

  // Match:
  // 1. Calls on tracked client variables: `var.method(...)` or `self.var.method(...)`
  // 2. Chained direct calls: `boto3.client('service').method(...)` or `boto3.resource('service').method(...)`
  for (const [varName, binding] of bindings.entries()) {
    if (binding.kind === 'session') continue; // session itself is not a service client

    const methodCallRe = new RegExp(
      `(?:(?:self|cls)\\s*\\.\\s*)?\\b${varName}\\s*\\.\\s*([a-zA-Z_]\\w*)\\s*\\(`,
      'g',
    );
    let m: RegExpExecArray | null;
    while ((m = methodCallRe.exec(source)) !== null) {
      const method = m[1];
      // Skip meta or exceptions property accesses
      if (['meta', 'exceptions', 'get_paginator', 'get_waiter'].includes(method)) continue;

      const openParen = m.index + m[0].length - 1;
      const closeParen = findBalancedParens(source, openParen);
      const callArgs = closeParen !== -1 ? source.slice(openParen + 1, closeParen) : '';

      const match = parseCallDetails(binding.service, method, callArgs, varName, m.index);
      // Inherit client-level env vars if any
      for (const ev of binding.envVars) {
        if (!match.envVars.includes(ev)) match.envVars.push(ev);
      }
      calls.push(match);
    }
  }

  // Chained direct calls: `boto3.client('service').method(...)`
  const directRe =
    /\bboto3\s*\.\s*(client|resource)\s*\(\s*['"]([a-zA-Z0-9_-]+)['"][^)]*\)\s*\.\s*([a-zA-Z_]\w*)\s*\(/g;
  let dm: RegExpExecArray | null;
  while ((dm = directRe.exec(source)) !== null) {
    const service = dm[2].toLowerCase();
    const method = dm[3];
    if (['meta', 'exceptions'].includes(method)) continue;

    const openParen = dm.index + dm[0].length - 1;
    const closeParen = findBalancedParens(source, openParen);
    const callArgs = closeParen !== -1 ? source.slice(openParen + 1, closeParen) : '';

    calls.push(
      parseCallDetails(service, method, callArgs, `boto3.${dm[1]}('${service}')`, dm.index),
    );
  }

  return calls;
}

/** Parse arguments and metadata for a specific service call. */
function parseCallDetails(
  service: string,
  method: string,
  argsText: string,
  clientVar: string,
  index: number,
): Boto3CallMatch {
  const operation = toPascalCase(method);
  const op = classifyOperation(method);
  const envVars = extractEnvVarNames(argsText);

  let bucket = extractKeywordLiteral(argsText, 'Bucket');
  let key = extractKeywordLiteral(argsText, 'Key');
  let parameter =
    extractKeywordLiteral(argsText, 'Name') || extractKeywordLiteral(argsText, 'Path');
  let functionName = extractKeywordLiteral(argsText, 'FunctionName');
  let jobName = extractKeywordLiteral(argsText, 'JobName');
  let tableName = extractKeywordLiteral(argsText, 'TableName');
  const queueUrl = extractKeywordLiteral(argsText, 'QueueUrl');
  const queueName = extractKeywordLiteral(argsText, 'QueueName');
  const secretId = extractKeywordLiteral(argsText, 'SecretId');

  // Positional fallback for standard patterns:
  // e.g. `download_file('my-bucket', 'key.json', ...)`
  // `upload_file('local.txt', 'my-bucket', 'key.txt')`
  if (!bucket && service === 's3') {
    if (method === 'download_file') {
      const pos = argsText.match(/^\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
      if (pos) {
        bucket = pos[1];
        key = pos[2];
      }
    } else if (method === 'upload_file') {
      const pos = argsText.match(/^\s*[^,]+,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
      if (pos) {
        bucket = pos[1];
        key = pos[2];
      }
    } else if (method === 'Bucket') {
      const pos = argsText.match(/^\s*['"]([^'"]+)['"]/);
      if (pos) bucket = pos[1];
    } else if (method === 'Object') {
      const pos = argsText.match(/^\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
      if (pos) {
        bucket = pos[1];
        key = pos[2];
      }
    }
  }

  if (
    !parameter &&
    service === 'ssm' &&
    (method === 'get_parameter' || method === 'put_parameter')
  ) {
    const pos = argsText.match(/^\s*['"]([^'"]+)['"]/);
    if (pos) parameter = pos[1];
  }

  if (!functionName && service === 'lambda' && (method === 'invoke' || method === 'get_function')) {
    const pos = argsText.match(/^\s*['"]([^'"]+)['"]/);
    if (pos) functionName = pos[1];
  }

  if (!jobName && service === 'glue' && (method === 'start_job_run' || method === 'get_job_run')) {
    const pos = argsText.match(/^\s*['"]([^'"]+)['"]/);
    if (pos) jobName = pos[1];
  }

  if (!tableName && service === 'dynamodb' && method === 'Table') {
    const pos = argsText.match(/^\s*['"]([^'"]+)['"]/);
    if (pos) tableName = pos[1];
  }

  let resource: string | undefined;
  let resourceType: string | undefined;
  if (bucket) {
    resource = bucket;
    resourceType = 'bucket';
  } else if (parameter) {
    resource = parameter;
    resourceType = 'parameter';
  } else if (functionName) {
    resource = functionName;
    resourceType = 'function';
  } else if (jobName) {
    resource = jobName;
    resourceType = 'job';
  } else if (tableName) {
    resource = tableName;
    resourceType = 'table';
  } else if (queueUrl || queueName) {
    resource = queueUrl || queueName;
    resourceType = 'queue';
  } else if (secretId) {
    resource = secretId;
    resourceType = 'secret';
  }

  return {
    service,
    operation,
    method,
    op,
    clientVar,
    bucket,
    key,
    parameter,
    functionName,
    jobName,
    tableName,
    queueUrl,
    queueName,
    secretId,
    resource,
    resourceType,
    envVars,
    index,
  };
}

export class Boto3Plugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'boto3',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, KNOWN_PACKAGES);
  }

  registerSchema(): { edgeTypes: EdgeTypeDeclaration[] } {
    return {
      edgeTypes: [
        {
          name: 'aws_call',
          category: 'aws',
          description: 'Direct AWS service call via boto3 (client/resource method)',
        },
        {
          name: 'aws_client',
          category: 'aws',
          description: 'Boto3 client, resource, or session initialization',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer | string,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [], edges: [] });
    }

    const source = typeof content === 'string' ? content : content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const hasImport = BOTO3_IMPORT_RE.test(source);
    const hasClientSignal = BOTO3_CLIENT_SIGNAL_RE.test(source);

    if (!hasImport && !hasClientSignal) {
      return ok(result);
    }

    if (hasClientSignal) {
      result.frameworkRole = 'boto3_client';
    } else {
      result.frameworkRole = 'boto3_usage';
    }

    // Also populate result.edges for direct callers (e.g. unit tests)
    const calls = extractBoto3Calls(source);
    for (const call of calls) {
      const line = lineOfIndex(source, call.index);
      result.edges!.push({
        edgeType: 'aws_call',
        targetSymbolId: `aws:${call.service}:${call.operation}`,
        metadata: {
          service: call.service,
          operation: call.operation,
          method: call.method,
          op: call.op,
          bucket: call.bucket,
          key: call.key,
          parameter: call.parameter,
          function: call.functionName,
          job: call.jobName,
          table: call.tableName,
          queue: call.queueUrl || call.queueName,
          secret: call.secretId,
          resource: call.resource,
          resourceType: call.resourceType,
          envVars: call.envVars,
          client: call.clientVar,
          line,
          file: filePath,
        },
        resolution: 'text_matched',
      });
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'python') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;

      const hasImport = BOTO3_IMPORT_RE.test(source);
      const hasClientSignal = BOTO3_CLIENT_SIGNAL_RE.test(source);
      if (!hasImport && !hasClientSignal) continue;

      const symbols = ctx.getSymbolsByFile(file.id);
      const calls = extractBoto3Calls(source);

      for (const call of calls) {
        const line = lineOfIndex(source, call.index);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) continue;

        edges.push({
          edgeType: 'aws_call',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `aws:${call.service}:${call.operation}`,
          metadata: {
            service: call.service,
            operation: call.operation,
            method: call.method,
            op: call.op,
            bucket: call.bucket,
            key: call.key,
            parameter: call.parameter,
            function: call.functionName,
            job: call.jobName,
            table: call.tableName,
            queue: call.queueUrl || call.queueName,
            secret: call.secretId,
            resource: call.resource,
            resourceType: call.resourceType,
            envVars: call.envVars,
            client: call.clientVar,
            line,
            file: file.path,
          },
          resolution: 'text_matched',
        });
      }
    }

    return ok(edges);
  }
}
