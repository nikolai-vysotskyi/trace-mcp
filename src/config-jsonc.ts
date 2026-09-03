/**
 * JSONC-aware config helpers.
 *
 * Uses `jsonc-parser` (from VS Code team) to modify ~/.trace-mcp/.config.json
 * while preserving comments, formatting, and trailing commas.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, type ModificationOptions, modify, parse } from 'jsonc-parser';
import {
  DEFAULT_CONFIG_JSONC,
  ensureGlobalDirs,
  GLOBAL_CONFIG_PATH,
  TRACE_MCP_HOME,
} from './global.js';
import { logger } from './logger.js';
import { isEphemeralProjectRoot, listProjects } from './registry.js';
import { acquireLock, type LockHandle, LockError, releaseLock } from './utils/pid-lock.js';
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

// ---------------------------------------------------------------------------
// Serialising the read-modify-write cycle (TRA-702)
// ---------------------------------------------------------------------------
//
// Every mutation here is read text -> compute edits -> atomically write the
// whole file back. Two of those interleaved lose one side's change entirely:
// the second writer's `atomicWriteString` publishes a buffer read before the
// first writer's rename. That was always true for two concurrent
// `saveProjectConfigJsonc` calls (two agent runs registering at once), and
// `pruneProjectConfigSections` makes it much easier to hit, because its read-
// to-write window spans hundreds of edits — ~2s on the first backlog drain,
// while agent processes keep registering projects.
//
// So the cycle takes a cross-process lock, and every writer in this file goes
// through it. Reads are not locked: a torn read is impossible (writers publish
// by rename) and a slightly stale one is harmless.

const CONFIG_LOCK_NAME = 'global-config';
/** How long a writer waits for a peer before giving up on the lock. */
const CONFIG_LOCK_WAIT_MS = 3000;
const CONFIG_LOCK_POLL_MS = 25;

function sleepSync(ms: number): void {
  // These call sites are sync (and on the CLI's startup path), so this is the
  // only way to back off without restructuring every caller to async.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquireConfigLock(waitMs: number): LockHandle | null {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return acquireLock({
        // Resolved per call, not at import: TRACE_MCP_HOME can be redirected
        // (tests, the TRA-611 rename), and a cached dir would scope the lock
        // to the wrong state directory.
        lockDir: path.join(TRACE_MCP_HOME, 'locks'),
        name: CONFIG_LOCK_NAME,
        op: 'config-write',
      });
    } catch (err) {
      if (!(err instanceof LockError)) throw err;
      if (Date.now() >= deadline) return null;
      sleepSync(CONFIG_LOCK_POLL_MS);
    }
  }
}

/**
 * Run a config read-modify-write while holding the global-config lock.
 *
 * On timeout it runs `fn` anyway. Losing the lock must not make a config write
 * fail outright — that is strictly worse than today's behaviour, and a wedged
 * lock file would otherwise brick every registration on the machine.
 */
function withGlobalConfigLock<T>(fn: () => T): T {
  const handle = tryAcquireConfigLock(CONFIG_LOCK_WAIT_MS);
  try {
    return fn();
  } finally {
    if (handle) releaseLock(handle);
  }
}

/**
 * Lock variant for janitorial work: returns `null` rather than proceeding
 * unlocked. Used by the sweep, whose whole risk is overwriting a concurrent
 * writer — and which loses nothing by trying again on the next hourly pass.
 */
function withGlobalConfigLockOrSkip<T>(fn: () => T): T | null {
  const handle = tryAcquireConfigLock(CONFIG_LOCK_WAIT_MS);
  if (!handle) return null;
  try {
    return fn();
  } finally {
    releaseLock(handle);
  }
}

/** `modifyGlobalConfigJsonc` without the lock — for callers already holding it. */
function modifyGlobalConfigJsoncUnlocked(jsonPath: (string | number)[], value: unknown): void {
  const text = readGlobalConfigText();
  const edits = modify(text, jsonPath, value, FORMAT_OPTS);
  const updated = applyEdits(text, edits);
  atomicWriteString(GLOBAL_CONFIG_PATH, updated, { mode: 0o600 });
}

/**
 * Set a value at `jsonPath` in the global JSONC config, preserving comments.
 * `jsonPath` is an array of property names / indices, e.g. `['projects', '/foo']`.
 * Pass `undefined` as value to remove the key.
 */
export function modifyGlobalConfigJsonc(jsonPath: (string | number)[], value: unknown): void {
  withGlobalConfigLock(() => modifyGlobalConfigJsoncUnlocked(jsonPath, value));
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
  // The read and the write are one critical section: the merge below is
  // computed from `existing`, so a peer writing in between would be silently
  // reverted by our write.
  withGlobalConfigLock(() => {
    const existing = parse(readGlobalConfigText()) as
      | { projects?: Record<string, Record<string, unknown>> }
      | undefined;
    const existingSection = existing?.projects?.[projectRoot] ?? {};
    modifyGlobalConfigJsoncUnlocked(['projects', projectRoot], {
      ...existingSection,
      ...config,
    });
  });
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
 * Removal is per-key against one in-memory buffer, then a single atomic write.
 * Replacing the whole `projects` object in one edit would be shorter, but it
 * reserialises every *retained* section too and so drops the comments a user
 * hand-wrote inside them — the per-project data `saveProjectConfigJsonc` and
 * the #218 regression tests already go out of their way to preserve. Looping
 * `removeProjectConfigJsonc` would keep the comments but re-read and rewrite
 * the file once per section; this keeps both properties.
 */
export function pruneProjectConfigSections(): string[] {
  // Held across the whole read-edit-write cycle. Without it, a section written
  // by a concurrent `setupProject()` after our read is erased by our write —
  // and if that lands between an agent run's save and its immediate
  // `loadConfig()`, the run indexes with schema defaults instead of its
  // detected config. The window is ~2s wide on the first backlog drain.
  return (
    withGlobalConfigLockOrSkip(() => {
      let text = readGlobalConfigText();
      const parsed = parse(text) as { projects?: Record<string, unknown> } | undefined;
      const projects = parsed?.projects;
      if (!projects || typeof projects !== 'object') return [];

      const registered = new Set(listProjects().map((p) => p.root));
      const removed: string[] = [];

      for (const root of Object.keys(projects)) {
        const claimed = registered.has(root);
        const dead = !claimed && !fs.existsSync(root);
        const orphanWorkdir = !claimed && isEphemeralProjectRoot(root);
        if (dead || orphanWorkdir) removed.push(root);
      }

      if (removed.length === 0) return []; // don't rewrite a healthy config

      for (const root of removed) {
        text = applyEdits(text, modify(text, ['projects', root], undefined, FORMAT_OPTS));
      }
      ensureGlobalDirs();
      atomicWriteString(GLOBAL_CONFIG_PATH, text, { mode: 0o600 });
      logger.debug({ removed: removed.length }, 'Pruned dead project sections from global config');
      return removed;
    }) ?? [] // lock busy — a writer is active; try again on the next sweep
  );
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
  return withGlobalConfigLock(() => {
    const text = readGlobalConfigText();
    const existing = (parse(text) as Record<string, unknown> | null) ?? {};
    const updatedText = applySettingsDiff(text, [], incoming, existing);
    if (updatedText !== text) {
      atomicWriteString(GLOBAL_CONFIG_PATH, updatedText, { mode: 0o600 });
    }
    return (parse(updatedText) as Record<string, unknown> | null) ?? {};
  });
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
 * Marker recording which of the one-shot `tools.preset` default rewrites below
 * have already run for this config. Without it the rewrite could not tell one
 * of our own former defaults apart from a deliberate choice, and every upgrade
 * would undo a user who re-selected it.
 *
 * Historically a boolean (v1, TRA-538). It is read as a version number now —
 * `true` means "v1 applied" — so a later stale default can be retired without
 * re-running the earlier rewrites against a user who deliberately re-picked
 * what they undid.
 */
const PRESET_MIGRATED_KEY = 'preset_default_migrated';

/**
 * Presets we once shipped as THE default, each with the marker version that
 * retires it. A config still carrying one of these is carrying our old default
 * rather than a choice — the key is present, just stale, so the additive
 * key-merge below never touches it and the install keeps paying for a surface
 * it never asked for.
 *
 * - v1 (TRA-538): `full` — the pre-TRA-402 default.
 * - v2 (TRA-711): `standard` — the default between `full` and `minimal`. Found
 *   in the field: a developer machine advertising 55 tools where `minimal`
 *   advertises 28, because the config predates TRA-402 and the v1 rewrite only
 *   looked at `full`.
 */
const PRESET_DEFAULT_MIGRATIONS: readonly { version: number; from: string }[] = [
  { version: 1, from: 'full' },
  { version: 2, from: 'standard' },
];

const PRESET_MIGRATION_VERSION = PRESET_DEFAULT_MIGRATIONS[PRESET_DEFAULT_MIGRATIONS.length - 1]
  .version as number;

/** Read the marker as a version. Legacy `true` means v1 was applied. */
function presetMigrationVersion(tools: Record<string, unknown> | undefined): number {
  const raw = tools?.[PRESET_MIGRATED_KEY];
  if (raw === true) return 1;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  return 0;
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
  return withGlobalConfigLock(() => migrateGlobalConfigUnlocked());
}

function migrateGlobalConfigUnlocked(): MigrateResult {
  const result: MigrateResult = { added: [], changed: false };

  const existingText = readGlobalConfigText();
  const existing = parse(existingText) as Record<string, unknown> | null;
  const defaults = parse(DEFAULT_CONFIG_JSONC) as Record<string, unknown>;

  if (!existing || !defaults) return result;

  let text = existingText;

  // TRA-538 / TRA-711: a config carrying one of our former defaults (see
  // PRESET_DEFAULT_MIGRATIONS) is carrying a stale value, not a choice. Adding
  // keys was never going to fix those: the key is present, so every such
  // install keeps paying for a tool surface it never picked. Rewrite it once
  // to whatever the template ships (a single source of truth, so this stays
  // right when the default moves again), silently, then bump the marker so a
  // user who later re-selects that preset is never reverted by an upgrade.
  const existingTools = existing.tools as Record<string, unknown> | undefined;
  const shippedPreset = (defaults.tools as Record<string, unknown> | undefined)?.preset;
  const appliedVersion = presetMigrationVersion(existingTools);

  if (typeof shippedPreset === 'string') {
    for (const { version, from } of PRESET_DEFAULT_MIGRATIONS) {
      if (version <= appliedVersion) continue;
      if (existingTools?.preset !== from || from === shippedPreset) continue;
      const edits = modify(text, ['tools', 'preset'], shippedPreset, FORMAT_OPTS);
      if (edits.length > 0) {
        text = applyEdits(text, edits);
        result.added.push(`tools.preset: ${from} → ${shippedPreset}`);
      }
      break;
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
  if (appliedVersion < PRESET_MIGRATION_VERSION) {
    const edits = modify(
      text,
      ['tools', PRESET_MIGRATED_KEY],
      PRESET_MIGRATION_VERSION,
      FORMAT_OPTS,
    );
    if (edits.length > 0) text = applyEdits(text, edits);
  }

  if (text !== existingText) {
    atomicWriteString(GLOBAL_CONFIG_PATH, text, { mode: 0o600 });
    result.changed = true;
    logger.info({ added: result.added }, 'Migrated global config — added new keys');
  }

  return result;
}
