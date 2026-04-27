/**
 * AwsS3Plugin — detects AWS S3 usage (aws-sdk v2, @aws-sdk/client-s3, @aws-sdk/lib-storage)
 * and extracts bucket access as graph edges.
 *
 * Pass 1 (extractNodes) — file role tagging based on imports + client/command/method signals.
 * Pass 2 (resolveEdges) — for each S3 command/method with a literal `Bucket: '...'` value,
 *   emit an s3_access edge from the enclosing symbol to a phantom `s3-bucket::<name>` node.
 *   The operation (read/write/delete/list) is preserved in metadata alongside the API flavour.
 *
 * Non-literal bucket names (env vars, interpolation) are skipped — they cannot be resolved
 * statically and would only add noise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const S3_PACKAGES = [
  'aws-sdk', // v2 (deprecated, still widespread)
  '@aws-sdk/client-s3', // v3 modular client
  '@aws-sdk/lib-storage', // v3 streaming Upload
];

const S3_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*['"](?:aws-sdk(?:\/clients\/s3)?|@aws-sdk\/client-s3|@aws-sdk\/lib-storage)['"]/;

const V3_CLIENT_RE = /\bnew\s+S3Client\s*\(/;
const V2_CLIENT_RE = /\bnew\s+(?:AWS\.)?S3\s*\(/;
const V3_UPLOAD_RE = /\bnew\s+Upload\s*\(/;

// v3 commands — union of supported operations. Keep in sync with OP_BY_COMMAND below.
const V3_COMMAND_LIST = [
  'GetObjectCommand',
  'HeadObjectCommand',
  'ListObjectsCommand',
  'ListObjectsV2Command',
  'ListBucketsCommand',
  'PutObjectCommand',
  'CopyObjectCommand',
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
  'CreateMultipartUploadCommand',
  'CompleteMultipartUploadCommand',
  'UploadPartCommand',
  'AbortMultipartUploadCommand',
] as const;

const V3_COMMAND_NAMED_RE = new RegExp(`\\bnew\\s+(${V3_COMMAND_LIST.join('|')})\\s*\\(`, 'g');

// v2 method calls on an S3 client instance (s3.getObject(...), client.upload(...), etc.)
const V2_METHOD_LIST = [
  'getObject',
  'headObject',
  'listObjects',
  'listObjectsV2',
  'listBuckets',
  'putObject',
  'copyObject',
  'deleteObject',
  'deleteObjects',
  'upload',
  'createMultipartUpload',
  'completeMultipartUpload',
  'uploadPart',
  'abortMultipartUpload',
] as const;

const V2_METHOD_NAMED_RE = new RegExp(`\\.(${V2_METHOD_LIST.join('|')})\\s*\\(`, 'g');

const V3_UPLOAD_NAMED_RE = /\bnew\s+Upload\s*\(/g;

// Simple signal for Pass 1 (no capture groups, cheap to test).
const V3_ANY_COMMAND_RE = new RegExp(`\\bnew\\s+(?:${V3_COMMAND_LIST.join('|')})\\s*\\(`);
const V2_ANY_METHOD_RE = new RegExp(`\\.(?:${V2_METHOD_LIST.join('|')})\\s*\\(`);

type S3Op = 'read' | 'write' | 'delete' | 'list';

const OP_BY_COMMAND: Record<string, S3Op> = {
  GetObjectCommand: 'read',
  HeadObjectCommand: 'read',
  ListObjectsCommand: 'list',
  ListObjectsV2Command: 'list',
  ListBucketsCommand: 'list',
  PutObjectCommand: 'write',
  CopyObjectCommand: 'write',
  DeleteObjectCommand: 'delete',
  DeleteObjectsCommand: 'delete',
  CreateMultipartUploadCommand: 'write',
  CompleteMultipartUploadCommand: 'write',
  UploadPartCommand: 'write',
  AbortMultipartUploadCommand: 'delete',
};

const OP_BY_V2_METHOD: Record<string, S3Op> = {
  getObject: 'read',
  headObject: 'read',
  listObjects: 'list',
  listObjectsV2: 'list',
  listBuckets: 'list',
  putObject: 'write',
  copyObject: 'write',
  deleteObject: 'delete',
  deleteObjects: 'delete',
  upload: 'write',
  createMultipartUpload: 'write',
  completeMultipartUpload: 'write',
  uploadPart: 'write',
  abortMultipartUpload: 'delete',
};

// Look ahead at most this many characters from a command opener to find `Bucket: 'literal'`.
// Covers typical multi-line options objects while avoiding accidentally binding to
// unrelated downstream code.
const BUCKET_LOOKAHEAD = 600;
const BUCKET_LITERAL_RE = /Bucket\s*:\s*['"`]([^'"`]+)['"`]/;

function findBucketAfter(source: string, startIdx: number): string | undefined {
  const window = source.slice(startIdx, startIdx + BUCKET_LOOKAHEAD);
  const m = window.match(BUCKET_LITERAL_RE);
  return m ? m[1] : undefined;
}

function hasS3Package(deps: Record<string, string> | undefined): boolean {
  if (!deps) return false;
  for (const pkg of S3_PACKAGES) {
    if (pkg in deps) return true;
  }
  return false;
}

export class AwsS3Plugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'aws-s3',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (hasS3Package(deps)) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return hasS3Package(deps);
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 's3_access',
          category: 's3',
          description: 'Access to an S3 bucket (read/write/delete/list)',
        },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [] };

    const hasImport = S3_IMPORT_RE.test(source);
    const hasV3Client = V3_CLIENT_RE.test(source);
    const hasV2Client = V2_CLIENT_RE.test(source);
    const hasUpload = V3_UPLOAD_RE.test(source);
    const hasV3Command = V3_ANY_COMMAND_RE.test(source);
    // V2 method shape (`.getObject(`) is ambiguous without the import gate — other libs
    // use the same names. Only trust it when the file imports aws-sdk.
    const hasV2Method = hasImport && V2_ANY_METHOD_RE.test(source);

    if (hasV3Client || hasV2Client) {
      result.frameworkRole = 's3_client';
    } else if (hasUpload) {
      result.frameworkRole = 's3_upload';
    } else if (hasV3Command || hasV2Method) {
      result.frameworkRole = 's3_usage';
    } else if (hasImport) {
      result.frameworkRole = 's3_usage';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;

      const hasImport = S3_IMPORT_RE.test(source);
      const hasV3Signal =
        V3_CLIENT_RE.test(source) || V3_ANY_COMMAND_RE.test(source) || V3_UPLOAD_RE.test(source);
      if (!hasImport && !hasV3Signal) continue;

      const symbols = ctx.getSymbolsByFile(file.id);

      const emit = (matchIdx: number, bucket: string, op: S3Op, api: 'v2' | 'v3', kind: string) => {
        const line = lineOfIndex(source, matchIdx);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) return;
        edges.push({
          edgeType: 's3_access',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `s3-bucket::${bucket}`,
          metadata: {
            op,
            api,
            kind,
            bucket,
            line,
            file: file.path,
          },
          resolution: 'text_matched',
        });
      };

      // v3 commands: `new <Command>({ ..., Bucket: '...' })`
      V3_COMMAND_NAMED_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = V3_COMMAND_NAMED_RE.exec(source)) !== null) {
        const cmd = m[1];
        const op = OP_BY_COMMAND[cmd];
        if (!op) continue;
        const bucket = findBucketAfter(source, m.index + m[0].length);
        if (!bucket) continue;
        emit(m.index, bucket, op, 'v3', cmd);
      }

      // v3 lib-storage: `new Upload({ params: { Bucket: '...' }, ... })`
      V3_UPLOAD_NAMED_RE.lastIndex = 0;
      while ((m = V3_UPLOAD_NAMED_RE.exec(source)) !== null) {
        const bucket = findBucketAfter(source, m.index + m[0].length);
        if (!bucket) continue;
        emit(m.index, bucket, 'write', 'v3', 'Upload');
      }

      // v2 methods: `s3.<method>({ ..., Bucket: '...' })`. Gated on import — `.getObject(`
      // is too common across unrelated libraries to trust standalone.
      if (hasImport) {
        V2_METHOD_NAMED_RE.lastIndex = 0;
        while ((m = V2_METHOD_NAMED_RE.exec(source)) !== null) {
          const method = m[1];
          const op = OP_BY_V2_METHOD[method];
          if (!op) continue;
          const bucket = findBucketAfter(source, m.index + m[0].length);
          if (!bucket) continue;
          emit(m.index, bucket, op, 'v2', method);
        }
      }
    }

    return ok(edges);
  }
}
