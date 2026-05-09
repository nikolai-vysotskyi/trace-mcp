/**
 * CorpusBuilder — materialise a CorpusManifest by running `packContext`
 * over the requested scope and writing the result through `CorpusStore`.
 *
 * Sits between the MCP-tool layer and the storage layer:
 *
 *   build_corpus tool ─▶ buildCorpus()  ─▶ packContext() ─▶ CorpusStore.save()
 *
 * Kept separate from `corpus-store.ts` so the storage layer stays
 * pure-CRUD (no Store / PluginRegistry coupling) and easy to test in
 * isolation.
 */

import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import { packContext } from '../tools/refactoring/pack-context.js';
import type { CorpusManifest, CorpusScope, CorpusStore } from './corpus-store.js';
import { validateCorpusName } from './corpus-store.js';

export interface BuildCorpusInput {
  /** Slug for the corpus. Validated against `validateCorpusName`. */
  name: string;
  /** Absolute path of the project being packed. */
  projectRoot: string;
  /** What to pack. */
  scope: CorpusScope;
  /** Subdirectory when scope=module. Ignored otherwise. */
  modulePath?: string;
  /** NL query when scope=feature. Ignored otherwise. */
  featureQuery?: string;
  /** Token budget passed to packContext. Default: 50000. */
  tokenBudget?: number;
  /** Pack strategy. Default: 'most_relevant'. */
  packStrategy?: 'most_relevant' | 'core_first' | 'compact';
  /** Optional human-readable description stored on the manifest. */
  description?: string;
  /** Allow overwriting an existing corpus with the same name. Default: false. */
  overwrite?: boolean;
}

export class CorpusBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusBuildError';
  }
}

export interface CorpusBuildDeps {
  store: Store;
  registry: PluginRegistry;
  corpora: CorpusStore;
}

/**
 * Build (or rebuild) a corpus. Validates inputs, packs the requested scope
 * via `packContext`, and persists the manifest + body through `CorpusStore`.
 *
 * The tokenBudget is passed straight to packContext. If the resulting body
 * is empty (e.g. an unknown module path), we throw rather than save a
 * useless corpus — caller surfaces the error to the user.
 */
export function buildCorpus(deps: CorpusBuildDeps, input: BuildCorpusInput): CorpusManifest {
  validateCorpusName(input.name);

  if (!input.overwrite && deps.corpora.exists(input.name)) {
    throw new CorpusBuildError(
      `Corpus "${input.name}" already exists; pass { overwrite: true } to replace.`,
    );
  }

  if (input.scope === 'module' && !input.modulePath) {
    throw new CorpusBuildError('scope=module requires modulePath');
  }
  if (input.scope === 'feature' && !input.featureQuery) {
    throw new CorpusBuildError('scope=feature requires featureQuery');
  }

  const tokenBudget = input.tokenBudget ?? 50_000;
  const strategy = input.packStrategy ?? 'most_relevant';

  const pack = packContext(deps.store, deps.registry, {
    scope: input.scope,
    path: input.modulePath,
    query: input.featureQuery,
    format: 'markdown',
    maxTokens: tokenBudget,
    // Wide net by default — corpora are intended to be re-queried, so we
    // include outlines + source + routes + models + dependencies.
    include: ['outlines', 'source', 'routes', 'models', 'dependencies'],
    compress: false,
    projectRoot: input.projectRoot,
    strategy,
  });

  if (!pack.content || pack.content.trim().length === 0) {
    throw new CorpusBuildError(
      `Pack produced no content for ${input.scope}` +
        (input.modulePath ? ` (path=${input.modulePath})` : '') +
        (input.featureQuery ? ` (query=${input.featureQuery})` : ''),
    );
  }

  // Symbol count: pack reports files_included; symbols are bundled in
  // outlines. We surface what packContext can answer cheaply.
  const previous = deps.corpora.load(input.name);
  const now = new Date().toISOString();

  const manifest: CorpusManifest = {
    name: input.name,
    projectRoot: input.projectRoot,
    scope: input.scope,
    modulePath: input.modulePath,
    featureQuery: input.featureQuery,
    tokenBudget,
    packStrategy: strategy,
    symbolCount: 0, // populated post-MVP from outline parsing
    fileCount: pack.files_included,
    estimatedTokens: pack.token_count,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    description: input.description,
  };

  return deps.corpora.save(manifest, pack.content);
}
