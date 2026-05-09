/**
 * Code Corpus storage.
 *
 * A corpus is a snapshot of project context (files + symbols + decisions)
 * compiled with `packContext()` and saved to disk so future Q&A queries
 * can prime an LLM with that fixed slice of the codebase. Inspired by
 * claude-mem v12.1 ("Knowledge Agents") — same idea, mapped to our
 * existing `pack_context` + `query_decisions` primitives.
 *
 * Layout (under `<TRACE_MCP_HOME>/corpora/`):
 *
 *     <name>.json    manifest (CorpusManifest)
 *     <name>.pack.md packed context body (markdown)
 *
 * Path-traversal hardening
 * ────────────────────────
 * `name` is the user-supplied slug used to derive both file paths. We
 * therefore enforce an alphanumeric + `-` + `_` whitelist, reject any
 * leading dot, AND validate `path.resolve(path.join(corporaDir, name))`
 * stays under `corporaDir`. claude-mem hit this attack surface with
 * their CorpusStore — we mirror the same defense.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TRACE_MCP_HOME } from '../shared/paths.js';

export const CORPORA_DIR = path.join(TRACE_MCP_HOME, 'corpora');

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type CorpusScope = 'project' | 'module' | 'feature';

export interface CorpusManifest {
  /** User-supplied slug; primary key. */
  name: string;
  /** Absolute path of the project this corpus was built from. */
  projectRoot: string;
  /** Pack scope: project (whole repo) / module (subdir) / feature (NL query). */
  scope: CorpusScope;
  /** Subdirectory path when scope=module. */
  modulePath?: string;
  /** Natural-language query when scope=feature. */
  featureQuery?: string;
  /** Token budget passed to packContext. */
  tokenBudget: number;
  /** Symbols included (count after pack). */
  symbolCount: number;
  /** Files included (count after pack). */
  fileCount: number;
  /** Approximate token count of the packed text. */
  estimatedTokens: number;
  /** Provider used to embed / pack (informational). */
  packStrategy: 'most_relevant' | 'core_first' | 'compact';
  createdAt: string;
  updatedAt: string;
  /** Free-form description from the user. */
  description?: string;
}

export class CorpusValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusValidationError';
  }
}

/**
 * Validate a user-supplied corpus name. Throws on invalid input so the
 * caller cannot accidentally write to an unintended path.
 */
export function validateCorpusName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new CorpusValidationError('Corpus name must be a non-empty string');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new CorpusValidationError(
      `Invalid corpus name "${name}": must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/`,
    );
  }
}

function corpusManifestPath(corporaDir: string, name: string): string {
  validateCorpusName(name);
  const target = path.resolve(path.join(corporaDir, `${name}.json`));
  // Defence in depth — even if validateCorpusName lets something pass we
  // refuse to leave the corpora directory.
  if (path.relative(corporaDir, target).startsWith('..')) {
    throw new CorpusValidationError(`Corpus path escapes corpora dir: ${target}`);
  }
  return target;
}

function corpusPackPath(corporaDir: string, name: string): string {
  validateCorpusName(name);
  const target = path.resolve(path.join(corporaDir, `${name}.pack.md`));
  if (path.relative(corporaDir, target).startsWith('..')) {
    throw new CorpusValidationError(`Corpus path escapes corpora dir: ${target}`);
  }
  return target;
}

export interface CorpusStoreOptions {
  /** Override the storage root (test-only). Defaults to ~/.trace-mcp/corpora. */
  rootDir?: string;
}

export class CorpusStore {
  readonly rootDir: string;

  constructor(opts: CorpusStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? CORPORA_DIR;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(this.rootDir, 0o700);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  exists(name: string): boolean {
    return fs.existsSync(corpusManifestPath(this.rootDir, name));
  }

  /**
   * Save a corpus manifest + packed body. Returns the saved manifest.
   * `updatedAt` is always overwritten with `new Date().toISOString()`.
   */
  save(manifest: CorpusManifest, packedText: string): CorpusManifest {
    validateCorpusName(manifest.name);
    this.ensureDir();
    const manifestPath = corpusManifestPath(this.rootDir, manifest.name);
    const packPath = corpusPackPath(this.rootDir, manifest.name);

    const final: CorpusManifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(final, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(packPath, packedText, 'utf-8');

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(manifestPath, 0o600);
        fs.chmodSync(packPath, 0o600);
      } catch {
        /* best-effort */
      }
    }
    return final;
  }

  /** Load a manifest by name. Returns null when missing. */
  load(name: string): CorpusManifest | null {
    const manifestPath = corpusManifestPath(this.rootDir, name);
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as CorpusManifest;
      // Sanity check the round-trip.
      if (parsed.name !== name) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Read the packed body for a corpus. Returns null when missing. */
  loadPackedBody(name: string): string | null {
    const packPath = corpusPackPath(this.rootDir, name);
    if (!fs.existsSync(packPath)) return null;
    try {
      return fs.readFileSync(packPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** List every corpus manifest currently on disk. */
  list(): CorpusManifest[] {
    if (!fs.existsSync(this.rootDir)) return [];
    const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    const out: CorpusManifest[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      const name = entry.name.slice(0, -'.json'.length);
      // Hidden / sidecar files (e.g. .DS_Store after `.json` strip) are
      // trivially rejected by NAME_PATTERN.
      if (!NAME_PATTERN.test(name)) continue;
      const manifest = this.load(name);
      if (manifest !== null) out.push(manifest);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Delete a corpus (manifest + packed body). Returns true when something
   * was removed; false when the corpus did not exist.
   */
  delete(name: string): boolean {
    const manifestPath = corpusManifestPath(this.rootDir, name);
    const packPath = corpusPackPath(this.rootDir, name);
    let removed = false;
    for (const target of [manifestPath, packPath]) {
      try {
        fs.unlinkSync(target);
        removed = true;
      } catch {
        /* missing is fine */
      }
    }
    return removed;
  }
}
