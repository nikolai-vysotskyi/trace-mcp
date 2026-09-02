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
import { isEphemeralProjectRoot, listProjects } from './registry.js';
import { atomicWriteString } from './utils/atomic-write.js';
import { readIfExists } from './utils/safe-fs.js';

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
  return readIfExists(GLOBAL_CONFIG_PATH) ?? DEFAULT_CONFIG_JSONC;
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
  atomicWriteString(GLOBAL_CONFIG_PATH, updated, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// High-level: save / remove project config (comment-safe replacements)
// ---------------------------------------------------------------------------

/**
 * Save per-project config section in the global config file (JSONC-safe).
 *
 * `modifyGlobalConfigJsonc` replaces the whole object at the path, so a bare
 * re-register (init --force / add --force) would silently drop caller-omitted
 * keys — e.g. a user-added `ignore` block — since callers here only ever pass
 * `{root, include, exclude}`. Merge onto the existing section first so
 * caller-supplied keys win but unrelated keys survive (#218).
 */
export function saveProjectConfigJsonc(projectRoot: string, config: Record<string, unknown>): void {
  ensureGlobalDirs();
  const existing = parse(readGlobalConfigText()) as
    | { projects?: Record<string, Record<string, unknown>> }
    | undefined;
  const existingSection = existing?.projects?.[projectRoot] ?? {};
  modifyGlobalConfigJsonc(['projects', projectRoot], { ...existingSection, ...config });
}

/** Remove a per-project config section from the global config file (JSONC-safe). */
export function removeProjectConfigJsonc(projectRoot: string): void {
  modifyGlobalConfigJsonc(['projects', projectRoot], undefined);
}

/**
 * Drop dead per-project sections from `.config.json` (TRA-702).
 *
 * `projects` is the only unbounded map in the global config, and it was the
 * only registration store with no sweep at all: registry.json has had
 * `sweepMissingRoots` / `sweepEphemeralProjects` since TRA-36 / TRA-335, but
 * `setupProject` writes here on a separate path that none of them reach. On
 * the reported machine that left 593 sections / 785 KB — reparsed on every
 * server start, i.e. on every agent run.
 *
 * Two kinds go, and only these two:
 *
 *  - the root no longer exists **and** no registry entry claims it. Both
 *    halves matter: registry.json is the authority for what the user actually
 *    registered and already runs a 7-day grace period, so an unmounted volume
 *    keeps its config here instead of being punished for being offline.
 *  - the root is a one-shot agent workdir that nothing registered. The Multica
 *    runtime abandons its checkout *in place*, so these stay on disk forever
 *    and an existence check alone never reaches them. An explicitly registered
 *    workdir-shaped root is a deliberate act (`add`/`init`) and is kept.
 *
 * One rewrite for the whole set, not one per section — a section-at-a-time
 * loop would re-serialise a megabyte hundreds of times.
 */
export function pruneProjectConfigSections(): string[] {
  const text = readGlobalConfigText();
  const parsed = parse(text) as { projects?: Record<string, unknown> } | undefined;
  const projects = parsed?.projects;
  if (!projects || typeof projects !== 'object') return [];

  const registered = new Set(listProjects().map((p) => p.root));
  const kept: Record<string, unknown> = {};
  const removed: string[] = [];

  for (const [root, section] of Object.entries(projects)) {
    const claimed = registered.has(root);
    const dead = !claimed && !fs.existsSync(root);
    const orphanWorkdir = !claimed && isEphemeralProjectRoot(root);
    if (dead || orphanWorkdir) removed.push(root);
    else kept[root] = section;
  }

  if (removed.length === 0) return []; // don't rewrite a healthy config

  modifyGlobalConfigJsonc(['projects'], kept);
  logger.debug({ removed: removed.length }, 'Pruned dead project sections from global config');
  return removed;
}

// ---------------------------------------------------------------------------
// Dashboard settings (PUT /api/settings): deep-merge + comment-safe write
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively walk `incoming` and apply one jsonc-parser edit per leaf path
 * that differs from `existing`, so untouched sibling keys — nested or not —
 * are left completely alone (both their value and their surrounding comments).
 *
 * Nulls mean "remove this key" (consistent with `modifyGlobalConfigJsonc`,
 * where passing `undefined` removes the key at that path — `null` is the only
 * way a JSON payload can express that intent). Arrays and primitives replace
 * the existing value wholesale rather than merging element-by-element.
 */
function applySettingsDiff(
  text: string,
  jsonPath: (string | number)[],
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): string {
  let result = text;
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue; // absent from payload — leave untouched
    const path = [...jsonPath, key];
    const existingValue = existing[key];

    if (value === null) {
      // Explicit null → remove the key entirely.
      if (existingValue === undefined) continue; // nothing to remove
      const edits = modify(result, path, undefined, FORMAT_OPTS);
      if (edits.length > 0) result = applyEdits(result, edits);
      continue;
    }

    if (isPlainObject(value) && isPlainObject(existingValue)) {
      // Both sides are objects — recurse so sibling nested keys survive.
      result = applySettingsDiff(result, path, value, existingValue);
      continue;
    }

    // Leaf value (or object replacing a non-object, or a brand-new key).
    const edits = modify(result, path, value, FORMAT_OPTS);
    if (edits.length > 0) result = applyEdits(result, edits);
  }
  return result;
}

/**
 * Deep-merge an incoming settings payload (e.g. from the dashboard's
 * `PUT /api/settings`) into the global JSONC config, preserving comments and
 * any nested keys the payload doesn't mention (#221).
 *
 * Returns the fully merged config object (parsed post-write) so callers can
 * echo it back in an API response.
 */
export function saveGlobalSettingsJsonc(
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  ensureGlobalDirs();
  const text = readGlobalConfigText();
  const existing = (parse(text) as Record<string, unknown> | null) ?? {};
  const updatedText = applySettingsDiff(text, [], incoming, existing);
  if (updatedText !== text) {
    atomicWriteString(GLOBAL_CONFIG_PATH, updatedText, { mode: 0o600 });
  }
  return (parse(updatedText) as Record<string, unknown> | null) ?? {};
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
 * Marker recording that the one-shot `tools.preset` default rewrite below has
 * already run for this config. Without it the rewrite could not tell our own
 * former default apart from a deliberate `full`, and every upgrade would undo
 * a user who re-selected it.
 */
const PRESET_MIGRATED_KEY = 'preset_default_migrated';

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

  // TRA-538: configs written before TRA-402 carry `tools.preset: "full"` — our
  // old default, not a choice. Adding keys was never going to fix those: the
  // key is present, just stale, so every such install keeps paying for the full
  // tool surface on every turn. Rewrite it once to whatever the template ships
  // (a single source of truth, so this stays right when the default moves
  // again), silently, then mark the config so a user who later re-selects
  // `full` is never reverted by a later upgrade.
  const existingTools = existing.tools as Record<string, unknown> | undefined;
  const shippedPreset = (defaults.tools as Record<string, unknown> | undefined)?.preset;
  const alreadyMigrated = existingTools?.[PRESET_MIGRATED_KEY] === true;

  if (
    !alreadyMigrated &&
    existingTools?.preset === 'full' &&
    typeof shippedPreset === 'string' &&
    shippedPreset !== 'full'
  ) {
    const edits = modify(text, ['tools', 'preset'], shippedPreset, FORMAT_OPTS);
    if (edits.length > 0) {
      text = applyEdits(text, edits);
      result.added.push(`tools.preset: full → ${shippedPreset}`);
    }
  }

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

  // Set after the loop above: on a config with no `tools` section at all, that
  // loop is what creates it, and writing the marker first would get clobbered.
  if (!alreadyMigrated) {
    const edits = modify(text, ['tools', PRESET_MIGRATED_KEY], true, FORMAT_OPTS);
    if (edits.length > 0) text = applyEdits(text, edits);
  }

  if (text !== existingText) {
    atomicWriteString(GLOBAL_CONFIG_PATH, text, { mode: 0o600 });
    result.changed = true;
    logger.info({ added: result.added }, 'Migrated global config — added new keys');
  }

  return result;
}
