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
  RawSymbol,
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

export interface PythonScope {
  id: string;
  type: 'module' | 'class' | 'function';
  name: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  indent: number;
  parent: PythonScope | null;
  baseClassName?: string;
  bindings: Map<string, Boto3ClientBinding>;
}

/**
 * Parse Python source into lexical scopes (module, class, def/async def)
 * based on indentation blocks.
 */
export function parsePythonScopes(source: string): PythonScope[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  const totalLength = source.length;
  const moduleScope: PythonScope = {
    id: 'scope:module',
    type: 'module',
    name: '<module>',
    startOffset: 0,
    endOffset: totalLength,
    startLine: 1,
    endLine: lineStarts.length,
    indent: -1,
    parent: null,
    bindings: new Map(),
  };

  const allScopes: PythonScope[] = [moduleScope];
  const stack: PythonScope[] = [moduleScope];

  for (let i = 0; i < lineStarts.length; i++) {
    const lineStart = lineStarts[i];
    let lineEnd = i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : totalLength;
    if (lineEnd > lineStart && source[lineEnd - 1] === '\r') {
      lineEnd--;
    }
    const rawLine = source.slice(lineStart, lineEnd);
    const matchWs = rawLine.match(/^(\s*)/);
    const leadingWs = matchWs ? matchWs[1] : '';
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    let indent = 0;
    for (const ch of leadingWs) {
      if (ch === '\t') indent += 4;
      else indent += 1;
    }

    const lineNumber = i + 1;

    // Pop any scopes whose indentation is >= current line's indentation
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      const popped = stack.pop()!;
      popped.endOffset = lineStart > 0 ? lineStart - 1 : 0;
      popped.endLine = lineNumber - 1;
    }

    const currentParent = stack[stack.length - 1];

    const classMatch = trimmed.match(/^class\s+([a-zA-Z_]\w*)(?:\s*\(\s*([a-zA-Z_]\w*))?/);
    const defMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z_]\w*)/);

    if (classMatch) {
      const scope: PythonScope = {
        id: `scope:class:${classMatch[1]}:${lineNumber}`,
        type: 'class',
        name: classMatch[1],
        baseClassName: classMatch[2],
        startOffset: lineStart,
        endOffset: totalLength,
        startLine: lineNumber,
        endLine: lineStarts.length,
        indent,
        parent: currentParent,
        bindings: new Map(),
      };
      stack.push(scope);
      allScopes.push(scope);
    } else if (defMatch) {
      const scope: PythonScope = {
        id: `scope:func:${defMatch[1]}:${lineNumber}`,
        type: 'function',
        name: defMatch[1],
        startOffset: lineStart,
        endOffset: totalLength,
        startLine: lineNumber,
        endLine: lineStarts.length,
        indent,
        parent: currentParent,
        bindings: new Map(),
      };
      stack.push(scope);
      allScopes.push(scope);
    }
  }

  return allScopes;
}

/** Find the deepest (innermost) scope containing the given source offset. */
export function findInnermostScope(scopes: PythonScope[], offset: number): PythonScope {
  let matched: PythonScope = scopes[0];
  for (const s of scopes) {
    if (offset >= s.startOffset && offset <= s.endOffset) {
      if (s.indent > matched.indent) {
        matched = s;
      }
    }
  }
  return matched;
}

/**
 * Resolve a client/resource binding at a specific call offset.
 * When isSelfOrCls is true (e.g. self.s3), looks strictly in the enclosing class scope.
 * Otherwise, climbs the lexical scope chain from innermost to module scope.
 */
export function resolveBindingInScope(
  scopes: PythonScope[],
  callOffset: number,
  varName: string,
  isSelfOrCls: boolean,
): Boto3ClientBinding | undefined {
  const scope = findInnermostScope(scopes, callOffset);

  if (isSelfOrCls) {
    let curr: PythonScope | null = scope;
    while (curr && curr.type !== 'class') {
      curr = curr.parent;
    }
    if (curr) {
      return curr.bindings.get(varName);
    }
    return undefined;
  }

  let curr: PythonScope | null = scope;
  while (curr) {
    const b = curr.bindings.get(varName);
    if (b) return b;
    curr = curr.parent;
  }
  return undefined;
}

/**
 * Discover client, resource, and session bindings populated into their respective scopes.
 */
export function discoverScopedBindings(source: string, scopes: PythonScope[]): void {
  // 1. Session variables: `sess = boto3.Session(...)` or `self.sess = boto3.Session(...)`
  const sessionRe =
    /(?:(?:self|cls)\s*\.\s*)?([a-zA-Z_]\w*)\s*=\s*(?:boto3(?:\.session)?|session)?\s*\.\s*Session\s*\(/g;
  let sm: RegExpExecArray | null;
  while ((sm = sessionRe.exec(source)) !== null) {
    const varName = sm[1];
    const isSelfOrCls = /^(?:self|cls)\s*\./.test(sm[0]);
    const openParen = sm.index + sm[0].length - 1;
    const closeParen = findBalancedParens(source, openParen);
    const body = closeParen !== -1 ? source.slice(openParen + 1, closeParen) : '';
    const region = extractKeywordLiteral(body, 'region_name');
    const envVars = extractEnvVarNames(body);

    const binding: Boto3ClientBinding = {
      variable: varName,
      service: '',
      kind: 'session',
      region,
      envVars,
    };

    const scope = findInnermostScope(scopes, sm.index);
    let targetScope = scope;
    if (isSelfOrCls) {
      let curr: PythonScope | null = scope;
      while (curr && curr.type !== 'class') {
        curr = curr.parent;
      }
      if (curr) targetScope = curr;
    }
    targetScope.bindings.set(varName, binding);
  }

  // 2. Direct client & resource assignments:
  const clientAssignRe =
    /(?:(?:self|cls)\s*\.\s*)?([a-zA-Z_]\w*)\s*=\s*(?:(?:boto3|[a-zA-Z_]\w*)\s*\.\s*(client|resource|create_client)|botocore(?:\.session)?\.(?:get_session\(\)\.)?create_client|(client|resource))\s*\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let cm: RegExpExecArray | null;
  while ((cm = clientAssignRe.exec(source)) !== null) {
    const varName = cm[1];
    const isSelfOrCls = /^(?:self|cls)\s*\./.test(cm[0]);
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
    const binding: Boto3ClientBinding = {
      variable: varName,
      service,
      kind,
      region,
      envVars,
    };

    const scope = findInnermostScope(scopes, cm.index);
    let targetScope = scope;
    if (isSelfOrCls) {
      let curr: PythonScope | null = scope;
      while (curr && curr.type !== 'class') {
        curr = curr.parent;
      }
      if (curr) targetScope = curr;
    }
    targetScope.bindings.set(varName, binding);
  }

  // 3. Sub-resources: e.g. `bucket = s3.Bucket('my-bucket')` or `self.table = self.dynamodb.Table('users')`
  const subResRe =
    /(?:(?:self|cls)\s*\.\s*)?([a-zA-Z_]\w*)\s*=\s*(?:(?:self|cls)\s*\.\s*)?([a-zA-Z_]\w*)\s*\.\s*(Bucket|Table|Queue)\s*\(\s*['"]([^'"]+)['"]/g;
  let subM: RegExpExecArray | null;
  while ((subM = subResRe.exec(source)) !== null) {
    const subVar = subM[1];
    const parentVar = subM[2];
    const resName = subM[4];
    const isSelfOrCls = /^(?:self|cls)\s*\./.test(subM[0]);
    const isParentSelfOrCls = /=\s*(?:self|cls)\s*\./.test(subM[0]);

    const parentBinding = resolveBindingInScope(scopes, subM.index, parentVar, isParentSelfOrCls);
    if (parentBinding && parentBinding.kind === 'resource') {
      const subBinding: Boto3ClientBinding = {
        variable: subVar,
        service: parentBinding.service,
        kind: 'resource',
        region: parentBinding.region,
        envVars: [resName],
      };
      const scope = findInnermostScope(scopes, subM.index);
      let targetScope = scope;
      if (isSelfOrCls) {
        let curr: PythonScope | null = scope;
        while (curr && curr.type !== 'class') {
          curr = curr.parent;
        }
        if (curr) targetScope = curr;
      }
      targetScope.bindings.set(subVar, subBinding);
    }
  }

  // 4. Class inheritance: inherit bindings from base class defined in same file
  for (const s of scopes) {
    if (s.type === 'class' && s.baseClassName) {
      const base = scopes.find((cand) => cand.type === 'class' && cand.name === s.baseClassName);
      if (base) {
        for (const [k, v] of base.bindings.entries()) {
          if (!s.bindings.has(k)) {
            s.bindings.set(k, v);
          }
        }
      }
    }
  }
}

/**
 * Scan a Python file and discover all client, resource, and session bindings across scopes.
 */
export function discoverBindings(source: string): Map<string, Boto3ClientBinding> {
  const scopes = parsePythonScopes(source);
  discoverScopedBindings(source, scopes);
  const allBindings = new Map<string, Boto3ClientBinding>();
  for (const s of scopes) {
    for (const [k, v] of s.bindings.entries()) {
      if (!allBindings.has(k)) {
        allBindings.set(k, v);
      }
    }
  }
  return allBindings;
}

/**
 * Scan a Python file for direct method calls on tracked boto3 clients/resources,
 * enforcing lexical scope boundaries to prevent cross-scope false positive edges.
 */
export function extractBoto3Calls(source: string): Boto3CallMatch[] {
  const scopes = parsePythonScopes(source);
  discoverScopedBindings(source, scopes);
  const calls: Boto3CallMatch[] = [];

  // 1. Method calls on variables: `var.method(...)` or `self.var.method(...)`
  const methodCallRe = /(?:(self|cls)\s*\.\s*)?([a-zA-Z_]\w*)\s*\.\s*([a-zA-Z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = methodCallRe.exec(source)) !== null) {
    const isSelfOrCls = Boolean(m[1]);
    const varName = m[2];
    const method = m[3];

    // Skip non-service properties / methods and standard collection builtins
    if (['meta', 'exceptions', 'get_paginator', 'get_waiter'].includes(method)) continue;
    if (['append', 'extend', 'split', 'strip', 'join', 'keys', 'values', 'items'].includes(method))
      continue;

    // Resolve binding in the current lexical scope
    const binding = resolveBindingInScope(scopes, m.index, varName, isSelfOrCls);
    if (!binding || binding.kind === 'session') continue;

    const openParen = m.index + m[0].length - 1;
    const closeParen = findBalancedParens(source, openParen);
    const callArgs = closeParen !== -1 ? source.slice(openParen + 1, closeParen) : '';

    const match = parseCallDetails(binding.service, method, callArgs, varName, m.index);
    for (const ev of binding.envVars) {
      if (!match.envVars.includes(ev)) match.envVars.push(ev);
    }
    calls.push(match);
  }

  // 2. Chained direct calls: `boto3.client('service').method(...)`
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

function awsOperationSymbol(call: Boto3CallMatch, source: string): RawSymbol {
  const targetSymbolId = `aws:${call.service}:${call.operation}`;
  const byteStart = Buffer.byteLength(source.slice(0, call.index), 'utf8');
  return {
    symbolId: targetSymbolId,
    name: call.operation,
    kind: 'function',
    fqn: targetSymbolId,
    signature: `${call.service}.${call.operation}`,
    byteStart,
    byteEnd: byteStart + Buffer.byteLength(call.method, 'utf8'),
    metadata: { service: call.service, operation: call.operation, type: 'aws_operation' },
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
    const operationSymbols = new Set<string>();
    for (const call of calls) {
      const line = lineOfIndex(source, call.index);
      const targetSymbolId = `aws:${call.service}:${call.operation}`;
      if (!operationSymbols.has(targetSymbolId)) {
        operationSymbols.add(targetSymbolId);
        result.symbols.push(awsOperationSymbol(call, source));
      }
      result.edges!.push({
        edgeType: 'aws_call',
        targetSymbolId,
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
    const operationOwners = new Map<string, { fileId: number; path: string; symbol: RawSymbol }>();

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

        const targetSymbolId = `aws:${call.service}:${call.operation}`;
        const owner = operationOwners.get(targetSymbolId);
        if (!owner || file.path < owner.path) {
          operationOwners.set(targetSymbolId, {
            fileId: file.id,
            path: file.path,
            symbol: awsOperationSymbol(call, source),
          });
        }

        edges.push({
          edgeType: 'aws_call',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId,
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

    // A file-local reindex can delete the shared symbol row while another file
    // still calls the operation. Re-anchor it from all current call sites before
    // the resolver persists edges, so no unrelated file needs to be reindexed.
    for (const [targetSymbolId, owner] of operationOwners) {
      if (!ctx.getSymbolByFqn(targetSymbolId)) {
        ctx.upsertSymbolForFile?.(owner.fileId, owner.symbol);
      }
    }

    return ok(edges);
  }
}
