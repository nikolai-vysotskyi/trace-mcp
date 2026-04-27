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
import { FileExtractor } from './file-extractor.js';
import { buildProjectContext } from './project-context.js';
import type { ExtractRequest, ExtractResponse } from './extract-pool.js';
import type { WorkspaceInfo } from './monorepo.js';

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

parentPort.on('message', async (req: InternalRequest) => {
  let result: ExtractResponse;
  try {
    const extractor = getExtractor(req.rootPath, req.workspaces);
    const r = await extractor.extract(req.relPath, req.force, {
      existing: req.existing,
      gitignored: req.gitignored,
    });
    if (r === 'skipped') result = { kind: 'skipped' };
    else if (r === 'error') result = { kind: 'error' };
    else result = { kind: 'ok', extraction: r };
  } catch {
    result = { kind: 'error' };
  }
  // Drop content cache entries for the file we just processed — keeps memory
  // bounded across many requests.
  fileContentCache.delete(req.relPath);
  parentPort!.postMessage({ id: req.id, result });
});
