/**
 * JSONC-aware config helpers.
 *
 * Uses `jsonc-parser` (from VS Code team) to modify ~/.trace-mcp/.config.json
 * while preserving comments, formatting, and trailing commas.
 */
import fs from 'node:fs';
import { applyEdits, type ModificationOptions, modify, parse } from 'jsonc-parser';
import { DEFAULT_CONFIG_JSONC, ensureGlobalDirs, GLOBAL_CONFIG_PATH } from './global.js';
import { logger } from './logger.js';

// Shared formatting options — match the 2-space indent used in DEFAULT_CONFIG_JSONC
const FORMAT_OPTS: ModificationOptions = {
  formattingOptions: {
    tabSize: 2,
    insertSpaces: true,
    eol: '\n',
  },
};

// ---------------------------------------------------------------------------
// Low-level: read / modify / write JSONC
// ---------------------------------------------------------------------------

/** Read global config as raw JSONC text. Returns DEFAULT_CONFIG_JSONC if file missing. */
export function readGlobalConfigText(): string {
  ensureGlobalDirs();
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return DEFAULT_CONFIG_JSONC;
  return fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
}

/**
 * Set a value at `jsonPath` in the global JSONC config, preserving comments.
 * `jsonPath` is an array of property names / indices, e.g. `['projects', '/foo']`.
 * Pass `undefined` as value to remove the key.
 */
export function modifyGlobalConfigJsonc(jsonPath: (string | number)[], value: unknown): void {
  const text = readGlobalConfigText();
  const edits = modify(text, jsonPath, value, FORMAT_OPTS);
  const updated = applyEdits(text, edits);
  fs.writeFileSync(GLOBAL_CONFIG_PATH, updated);
}

// ---------------------------------------------------------------------------
// High-level: save / remove project config (comment-safe replacements)
// ---------------------------------------------------------------------------

/** Save per-project config section in the global config file (JSONC-safe). */
export function saveProjectConfigJsonc(projectRoot: string, config: Record<string, unknown>): void {
  ensureGlobalDirs();
  modifyGlobalConfigJsonc(['projects', projectRoot], config);
}

/** Remove a per-project config section from the global config file (JSONC-safe). */
export function removeProjectConfigJsonc(projectRoot: string): void {
  modifyGlobalConfigJsonc(['projects', projectRoot], undefined);
}

// ---------------------------------------------------------------------------
// Config migration: merge new keys from DEFAULT_CONFIG_JSONC into existing
// ---------------------------------------------------------------------------

export interface MigrateResult {
  added: string[];
  /** true if the file was modified */
  changed: boolean;
}

/**
 * Migrate global config: for every top-level key present in DEFAULT_CONFIG_JSONC
 * but missing in the existing config, insert it (with comments from the template).
 *
 * Does NOT overwrite existing user values — only adds what's missing.
 * Works at top-level section granularity (ai, security, predictive, etc.).
 */
export function migrateGlobalConfig(): MigrateResult {
  ensureGlobalDirs();
  const result: MigrateResult = { added: [], changed: false };

  const existingText = readGlobalConfigText();
  const existing = parse(existingText) as Record<string, unknown> | null;
  const defaults = parse(DEFAULT_CONFIG_JSONC) as Record<string, unknown>;

  if (!existing || !defaults) return result;

  let text = existingText;

  for (const key of Object.keys(defaults)) {
    if (key in existing) {
      // Key exists — check for missing nested keys (one level deep)
      if (
        typeof defaults[key] === 'object' &&
        defaults[key] !== null &&
        !Array.isArray(defaults[key]) &&
        typeof existing[key] === 'object' &&
        existing[key] !== null &&
        !Array.isArray(existing[key])
      ) {
        const defaultSub = defaults[key] as Record<string, unknown>;
        const existingSub = existing[key] as Record<string, unknown>;
        for (const subKey of Object.keys(defaultSub)) {
          if (!(subKey in existingSub)) {
            const edits = modify(text, [key, subKey], defaultSub[subKey], FORMAT_OPTS);
            if (edits.length > 0) {
              text = applyEdits(text, edits);
              result.added.push(`${key}.${subKey}`);
            }
          }
        }
      }
      continue;
    }

    // Top-level key missing entirely — add it
    const edits = modify(text, [key], defaults[key], FORMAT_OPTS);
    if (edits.length > 0) {
      text = applyEdits(text, edits);
      result.added.push(key);
    }
  }

  if (text !== existingText) {
    fs.writeFileSync(GLOBAL_CONFIG_PATH, text);
    result.changed = true;
    logger.info({ added: result.added }, 'Migrated global config — added new keys');
  }

  return result;
}
