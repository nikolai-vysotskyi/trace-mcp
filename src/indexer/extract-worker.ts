/**
 * Worker entry for the extract pool. Each worker hosts its own plugin
 * registry and parser cache; the main thread dispatches per-file extract
 * requests over `parentPort`.
 *
 * The worker has NO database access — `existing` and `gitignored` are
 * resolved on the main thread and shipped in the request.
 */
import { parentPort } from 'node:worker_threads';
import { PluginRegistry } from '../plugin-api/registry.js';
import { initContentHasher } from '../util/hash.js';
import type { DropProjectMessage, ExtractRequest, ExtractResponse } from './extract-pool.js';
import { FileExtractor } from './file-extractor.js';
import type { WorkspaceInfo } from './monorepo.js';
import { buildProjectContext } from './project-context.js';

if (!parentPort) {
  throw new Error('extract-worker.ts must be loaded as a worker_thread');
}

const registry = PluginRegistry.createWithDefaults();

// Cache one FileExtractor per rootPath. The wsPluginCache + parser cache
// live inside the extractor, so reusing it across requests is critical.
const extractorByRoot = new Map<string, FileExtractor>();

// Cached ProjectContext per rootPath. buildProjectContext reads package.json
// + composer.json + pyproject.toml from disk; calling it per-file would do
// 100+ readFileSync per worker per indexing run.
const projectContextByRoot = new Map<string, ReturnType<typeof buildProjectContext>>();

// Edge resolvers re-read files from disk if cache misses. Workers don't
// share their file content with main, so this map is purely a per-extract
// scratch buffer (Pass 2 in pipeline.ts re-reads from disk on cache miss).
const fileContentCache = new Map<string, string>();

function getExtractor(rootPath: string, workspaces: WorkspaceInfo[]): FileExtractor {
  let e = extractorByRoot.get(rootPath);
  if (!e) {
    e = new FileExtractor({
      registry,
      rootPath,
      workspaces,
      gitignore: undefined,
      fileContentCache,
      buildProjectContext: () => {
        let ctx = projectContextByRoot.get(rootPath);
        if (!ctx) {
          ctx = buildProjectContext(rootPath);
          projectContextByRoot.set(rootPath, ctx);
        }
        return ctx;
      },
    });
    extractorByRoot.set(rootPath, e);
  }
  return e;
}

interface InternalRequest extends ExtractRequest {
  id: number;
}

type InboundMessage = InternalRequest | DropProjectMessage;

parentPort.on('message', async (msg: InboundMessage) => {
  // Out-of-band control message: drop per-project caches. Workers grow these
  // monotonically across the daemon's lifetime otherwise; long-running
  // deployments with project churn would slowly accumulate stale
  // FileExtractor + ProjectContext entries in worker RSS.
  if ('kind' in msg && msg.kind === 'drop_project') {
    extractorByRoot.delete(msg.rootPath);
    projectContextByRoot.delete(msg.rootPath);
    return;
  }

  const req = msg as InternalRequest;
  let result: ExtractResponse;
  try {
    await initContentHasher();
    const extractor = getExtractor(req.rootPath, req.workspaces);
    // WHY: extract() now returns ExtractResponse directly — pass through.
    // The 'mtime_updated' variant flows back to the main thread which holds
    // the DB handle; the worker context has no store.
    result = await extractor.extract(req.relPath, req.force, {
      existing: req.existing,
      gitignored: req.gitignored,
    });
  } catch {
    result = { kind: 'error' };
  }
  // Drop content cache entries for the file we just processed — keeps memory
  // bounded across many requests.
  fileContentCache.delete(req.relPath);
  parentPort!.postMessage({ id: req.id, result });
});
