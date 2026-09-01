/**
 * MCP client configuration: detect and write trace-mcp server entries.
 * Supports both project-scoped and global installation.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEdits, type FormattingOptions, modify, parse as parseJsonc } from 'jsonc-parser';
import YAML from 'yaml';
import { atomicWriteJson, atomicWriteString } from '../utils/atomic-write.js';
import { readIfExists } from '../utils/safe-fs.js';
import { isGuardHookInstalled } from './hooks.js';
import { getLauncherPath } from './launcher.js';
import { hasTweakccPrompts } from './tweakcc.js';
import type { DetectedMcpClient, InitStepResult } from './types.js';

const HOME = os.homedir();

/**
 * Server key clients register us under. `MCP_KEY` is what `init` writes
 * going forward; `LEGACY_MCP_KEY` is the pre-TRA-611 name every writer below
 * also deletes/replaces in place, so re-running `init` migrates a client
 * seamlessly instead of leaving both keys registered side by side.
 */
export const MCP_KEY = 'trace';
export const LEGACY_MCP_KEY = 'trace-mcp';

/**
 * Detect whether Claude Desktop (the unified Claude.app on macOS, or the
 * Claude Desktop binary on Windows/Linux) is currently running.
 *
 * Why this matters: Claude.app owns `claude_desktop_config.json` at runtime
 * and rewrites the whole file whenever its `preferences` change, WITHOUT
 * preserving foreign top-level keys like `mcpServers`. So if we write an
 * mcpServers entry while the app is open, the next preferences update
 * silently drops it.
 */
function isClaudeDesktopRunning(): boolean {
  try {
    if (process.platform === 'darwin') {
      // Can't use `pgrep -x Claude` — on macOS ps reports the full bundle path
      // as the comm, and `-x` needs an exact match. Can't use `pgrep Claude`
      // either — it would also match the Claude Code CLI (lowercase `claude`
      // binary in ~/.cursor/... or ~/Library/.../claude.app). Match the
      // unified-app bundle path explicitly.
      const out = execSync('ps -A -o command=', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /\/Applications\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/m.test(out);
    }
    if (process.platform === 'linux') {
      // Linux Claude Desktop binary is `claude-desktop` — distinct from Code CLI.
      execSync('pgrep -x claude-desktop', { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq Claude.exe" /FO CSV /NH', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /Claude\.exe/i.test(out);
    }
  } catch {
    // Non-zero exit or missing tool — treat as not running.
  }
  return false;
}

interface McpServerEntry {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Legacy field, never written by `init` anymore (GH #354): setting it
   * server-wide forced Claude Code to load all ~169 tools into the system
   * prompt (~52k tokens) instead of the per-tool `_meta: {
   * 'anthropic/alwaysLoad': true }` stamp already applied by
   * `stampAlwaysLoad()` (src/server/tool-gate-helpers.ts) to the 15
   * first-five-minutes tools, which gives the same "available from turn
   * one" property at ~6.9k tokens. Kept on the type only so drift detection
   * (`entryMatches`/`pinpointEntryDrift`) can recognize and flag a `true`
   * left over from an older `trace-mcp init` run as stale.
   */
  alwaysLoad?: boolean;
}

/**
 * Build the MCP command entry. All clients use the stable launcher shim at
 * ~/.trace-mcp/bin/trace-mcp — the shim resolves node + dist/cli.js at
 * runtime from launcher.env (or probe fallback), so the MCP registration
 * path is version-independent and survives node upgrades.
 */
function buildMcpEntry(): { command: string } {
  return { command: getLauncherPath() };
}

type McpScope = 'global' | 'project';

/**
 * Configure selected MCP clients to use trace-mcp.
 * Global scope: writes to user-level config (works in any project).
 * Project scope: writes to project-local config.
 */
export function configureMcpClients(
  clientNames: DetectedMcpClient['name'][],
  projectRoot: string,
  opts: { scope: McpScope; dryRun?: boolean },
): InitStepResult[] {
  const results: InitStepResult[] = [];

  for (const name of clientNames) {
    // JetBrains AI Assistant: config stored in IDE XML (llm.mcpServers.xml), not editable as JSON.
    // If Claude Desktop is also selected, user can "Import from Claude" in the IDE.
    if (name === 'jetbrains-ai') {
      const hasClaudeDesktop = clientNames.includes('claude-desktop');
      results.push({
        target: 'JetBrains AI Assistant',
        action: 'skipped',
        detail: hasClaudeDesktop
          ? 'Use "Import from Claude" in Settings → Tools → AI Assistant → MCP'
          : 'Add via Settings → Tools → AI Assistant → MCP → Add → Command: trace, Args: serve',
      });
      continue;
    }

    // Warp: configuration is stored in cloud-synced storage, not a writable file.
    // The user must paste the entry via Settings → Agents → MCP servers. If
    // claude-code is also selected, Warp can pick our entry up automatically
    // via "File-based MCP servers" detection.
    if (name === 'warp') {
      const hasClaudeCode = clientNames.includes('claude-code');
      const launcher = getLauncherPath();
      // No working_directory: Warp's MCP config is cloud-synced and user-level,
      // so pinning it to the directory `init` ran in would be wrong everywhere
      // else (TRA-501). Warp launches the server in the session's own directory.
      const snippet = JSON.stringify({
        mcpServers: {
          [MCP_KEY]: { command: launcher, args: ['serve'] },
        },
      });
      results.push({
        target: 'Warp',
        action: 'skipped',
        detail: hasClaudeCode
          ? 'Enable Settings → Agents → MCP servers → "File-based MCP servers" to inherit trace from Claude Code, or paste: ' +
            snippet
          : 'Open Settings → Agents → MCP servers → + Add → paste: ' + snippet,
      });
      continue;
    }

    // AMP (Sourcegraph Amp): JSONC with the literal-dot key `amp.mcpServers`.
    // Use jsonc-parser's modify()/applyEdits() so existing comments and formatting
    // are preserved across writes.
    if (name === 'amp') {
      const configPath = getConfigPath(name, projectRoot, opts.scope);
      if (!configPath) {
        results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
        continue;
      }
      const entry = buildExpectedEntry(name, projectRoot, opts.scope);

      if (fs.existsSync(configPath) && ampEntryMatches(configPath, entry)) {
        results.push({ target: configPath, action: 'already_configured', detail: name });
        continue;
      }
      if (opts.dryRun) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Would configure ${name} (${opts.scope})`,
        });
        continue;
      }
      try {
        const action = writeAmpJsoncEntry(configPath, entry);
        results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
      } catch (err) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Error: ${(err as Error).message}`,
        });
      }
      continue;
    }

    // Factory Droid: standard JSON `mcpServers`, but each entry needs `type: "stdio"`.
    if (name === 'factory-droid') {
      const configPath = getConfigPath(name, projectRoot, opts.scope);
      if (!configPath) {
        results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
        continue;
      }
      const entry = buildExpectedEntry(name, projectRoot, opts.scope) as McpServerEntry & {
        type: 'stdio';
      };

      if (fs.existsSync(configPath) && factoryEntryMatches(configPath, entry)) {
        results.push({ target: configPath, action: 'already_configured', detail: name });
        continue;
      }
      if (opts.dryRun) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Would configure ${name} (${opts.scope})`,
        });
        continue;
      }
      try {
        const action = writeFactoryJsonEntry(configPath, entry);
        results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
      } catch (err) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Error: ${(err as Error).message}`,
        });
      }
      continue;
    }

    // Hermes Agent: YAML format, always global, key `mcp_servers.trace-mcp`.
    if (name === 'hermes') {
      const configPath = getConfigPath(name, projectRoot, opts.scope);
      if (!configPath) {
        results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
        continue;
      }

      const entry = buildExpectedEntry(name, projectRoot, opts.scope);

      if (fs.existsSync(configPath) && hermesEntryMatches(configPath, entry)) {
        results.push({ target: configPath, action: 'already_configured', detail: name });
        continue;
      }

      if (opts.dryRun) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Would configure ${name} (${opts.scope})`,
        });
        continue;
      }

      try {
        const action = writeHermesYamlEntry(configPath, entry);
        results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
      } catch (err) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Error: ${(err as Error).message}`,
        });
      }
      continue;
    }

    // Codex: TOML format
    if (name === 'codex') {
      const configPath = getConfigPath(name, projectRoot, opts.scope);
      if (!configPath) {
        results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
        continue;
      }

      // Check if already configured under the current key AND the legacy
      // section is gone — a legacy-only or both-present `[mcp_servers.*]`
      // section falls through to the write path below, which migrates it
      // (see writeCodexTomlEntry). Requiring legacy absence here matters:
      // otherwise a file with both sections short-circuits to
      // already_configured and Codex spawns two copies of the server.
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf-8');
          if (
            codexSectionHeaderPattern(MCP_KEY).test(content) &&
            !codexSectionHeaderPattern(LEGACY_MCP_KEY).test(content)
          ) {
            results.push({ target: configPath, action: 'already_configured', detail: name });
            continue;
          }
        } catch {
          /* malformed — will append */
        }
      }

      if (opts.dryRun) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Would configure ${name} (${opts.scope})`,
        });
        continue;
      }

      try {
        const action = writeCodexTomlEntry(
          configPath,
          buildExpectedEntry(name, projectRoot, opts.scope),
        );
        results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
      } catch (err) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail: `Error: ${(err as Error).message}`,
        });
      }
      continue;
    }

    // All other clients: JSON format with mcpServers key
    const configPath = getConfigPath(name, projectRoot, opts.scope);
    if (!configPath) {
      results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
      continue;
    }

    // Claude Desktop (the unified Claude.app) rewrites claude_desktop_config.json
    // whenever its own preferences change, dropping any foreign top-level keys.
    // If it's running during init, our write wins briefly and then gets clobbered
    // on the next preferences flush. Refuse to write and tell the user to quit.
    if (name === 'claude-desktop' && !opts.dryRun && isClaudeDesktopRunning()) {
      results.push({
        target: configPath,
        action: 'skipped',
        detail:
          'Claude.app is running — it will overwrite mcpServers. Quit Claude.app completely (Cmd+Q on macOS), then re-run `trace-mcp init`.',
      });
      continue;
    }

    if (opts.dryRun) {
      results.push({
        target: configPath,
        action: 'skipped',
        detail: `Would configure ${name} (${opts.scope})`,
      });
      continue;
    }

    // All clients point at the stable launcher shim. The shim handles all
    // node/cli-path resolution at runtime, so the registration stays valid
    // across node upgrades, nvm switches, and trace-mcp reinstalls.
    const entry: McpServerEntry = buildExpectedEntry(name, projectRoot, opts.scope);

    // Refresh-in-place: if an existing entry matches what we'd write, report
    // already_configured; otherwise overwrite. This keeps the entry current
    // when node/bin paths change across trace-mcp upgrades without requiring
    // --force, and heals stale bare-`trace-mcp` commands from older installs.
    if (fs.existsSync(configPath) && entryMatches(configPath, entry)) {
      results.push({ target: configPath, action: 'already_configured', detail: name });
      continue;
    }

    try {
      const action = writeJsonEntry(configPath, entry);

      // For Claude Desktop specifically, verify the write survived. The app
      // may have been launched between our isClaudeDesktopRunning() check
      // and now; if it flushed preferences, our entry is already gone.
      if (name === 'claude-desktop' && !verifyTraceMcpEntry(configPath)) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail:
            'Write was overwritten by Claude.app. Quit Claude.app completely (Cmd+Q on macOS), then re-run `trace-mcp init`.',
        });
        continue;
      }

      results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
    } catch (err) {
      results.push({
        target: configPath,
        action: 'skipped',
        detail: `Error: ${(err as Error).message}`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// JSON writers (Claude Code, Claw, Claude Desktop, Cursor, Windsurf, Continue, Junie)
// ---------------------------------------------------------------------------

/**
 * Verify that `mcpServers[MCP_KEY]` is present on disk. Used after writing
 * Claude Desktop's config to detect the Claude.app overwrite race.
 */
function verifyTraceMcpEntry(configPath: string): boolean {
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return Boolean(content?.mcpServers?.[MCP_KEY]);
  } catch {
    return false;
  }
}

function entryMatches(configPath: string, expected: McpServerEntry): boolean {
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const servers = content?.mcpServers;
    // A lingering legacy key must always force the write path (which deletes
    // it) — otherwise a config with both `trace` (already correct) and a
    // stale `trace-mcp` short-circuits to already_configured, and the client
    // keeps spawning two copies of the same server forever.
    if (servers && typeof servers === 'object' && LEGACY_MCP_KEY in servers) return false;
    const current = servers?.[MCP_KEY];
    if (!current || typeof current !== 'object') return false;
    if (current.command !== expected.command) return false;
    if (JSON.stringify(current.args ?? []) !== JSON.stringify(expected.args)) return false;
    if ((current.cwd ?? undefined) !== (expected.cwd ?? undefined)) return false;
    // env is optional — compare only if either side has it
    if (expected.env || current.env) {
      if (JSON.stringify(current.env ?? {}) !== JSON.stringify(expected.env ?? {})) return false;
    }
    // alwaysLoad must match — we never expect it set anymore (GH #354), so a
    // stale `true` left by an older `init` is flagged and refreshed away.
    if ((current.alwaysLoad ?? false) !== (expected.alwaysLoad ?? false)) return false;
    return true;
  } catch {
    return false;
  }
}

function writeJsonEntry(configPath: string, entry: McpServerEntry): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let config: Record<string, unknown> = {};
  let isNew = true;
  const raw = readIfExists(configPath);
  if (raw !== null) {
    try {
      config = JSON.parse(raw);
      isNew = false;
    } catch {
      /* malformed — overwrite */
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const servers = config.mcpServers as Record<string, unknown>;
  delete servers[LEGACY_MCP_KEY];
  servers[MCP_KEY] = entry;

  atomicWriteJson(configPath, config);
  return isNew ? 'created' : 'updated';
}

// ---------------------------------------------------------------------------
// YAML writer (Hermes Agent)
// ---------------------------------------------------------------------------

interface HermesYamlEntry extends McpServerEntry {
  timeout?: number;
  connect_timeout?: number;
}

/** Parse existing config.yaml (if any) and check whether our entry already
 *  matches. Uses a real YAML parse so comments and neighbouring keys are not
 *  mistaken for the trace-mcp block. */
function hermesEntryMatches(configPath: string, expected: HermesYamlEntry): boolean {
  try {
    const doc = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown> | null;
    const servers = doc?.mcp_servers as Record<string, unknown> | undefined;
    // A lingering legacy key must force the write path (which deletes it) —
    // see entryMatches() above for why.
    if (servers && LEGACY_MCP_KEY in servers) return false;
    const current = servers?.[MCP_KEY] as Record<string, unknown> | undefined;
    if (!current) return false;
    if (current.command !== expected.command) return false;
    if (JSON.stringify(current.args ?? []) !== JSON.stringify(expected.args)) return false;
    if ((current.cwd ?? undefined) !== (expected.cwd ?? undefined)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Update or append the `mcp_servers.trace-mcp` block in `~/.hermes/config.yaml`.
 *  Preserves existing keys/comments by parsing → mutating via the Document API →
 *  serializing back, which keeps the surrounding document shape intact. */
function writeHermesYamlEntry(configPath: string, entry: HermesYamlEntry): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let doc: YAML.Document;
  let isNew = true;
  const raw = readIfExists(configPath);
  if (raw !== null) {
    isNew = false;
    doc = YAML.parseDocument(raw);
    if (doc.errors.length > 0) {
      // Can't trust an unparseable doc — start fresh to avoid destroying user data.
      throw new Error(`Hermes config.yaml has parse errors: ${doc.errors[0].message}`);
    }
  } else {
    doc = new YAML.Document({});
  }

  const value: Record<string, unknown> = {
    command: entry.command,
    args: entry.args,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    // Hermes' own defaults are low — trace's first boot (indexing) can be slow.
    timeout: entry.timeout ?? 180,
    connect_timeout: entry.connect_timeout ?? 120,
  };

  // hasIn guards deleteIn: on a document with no `mcp_servers` collection yet
  // (fresh install), deleteIn throws instead of no-op'ing.
  if (doc.hasIn(['mcp_servers', LEGACY_MCP_KEY])) {
    doc.deleteIn(['mcp_servers', LEGACY_MCP_KEY]);
  }
  doc.setIn(['mcp_servers', MCP_KEY], value);
  atomicWriteString(configPath, doc.toString({ lineWidth: 0 }), { rejectSymlinks: true });
  return isNew ? 'created' : 'updated';
}

// ---------------------------------------------------------------------------
// AMP JSONC writer (top-level key is the literal `amp.mcpServers`)
// ---------------------------------------------------------------------------

const AMP_FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' };

function ampEntryMatches(configPath: string, expected: McpServerEntry): boolean {
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseJsonc(content) as Record<string, unknown> | null;
    const servers = parsed?.['amp.mcpServers'] as Record<string, unknown> | undefined;
    // A lingering legacy key must force the write path (which deletes it) —
    // see entryMatches() above for why.
    if (servers && LEGACY_MCP_KEY in servers) return false;
    const current = servers?.[MCP_KEY] as Record<string, unknown> | undefined;
    if (!current) return false;
    if (current.command !== expected.command) return false;
    if (JSON.stringify(current.args ?? []) !== JSON.stringify(expected.args)) return false;
    if ((current.cwd ?? undefined) !== (expected.cwd ?? undefined)) return false;
    return true;
  } catch {
    return false;
  }
}

function writeAmpJsoncEntry(configPath: string, entry: McpServerEntry): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const value: Record<string, unknown> = {
    command: entry.command,
    args: entry.args,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  };

  let isNew = true;
  let content = '{}';
  // Atomic read: avoids TOCTOU between existsSync and readFileSync.
  try {
    content = fs.readFileSync(configPath, 'utf-8') || '{}';
    isNew = false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // jsonc-parser preserves comments and formatting around untouched regions.
  // modify() with value=undefined throws if the path doesn't already exist —
  // only ask it to delete the legacy key when there's actually one there.
  const existingServers = (parseJsonc(content) as Record<string, unknown> | null)?.[
    'amp.mcpServers'
  ] as Record<string, unknown> | undefined;
  if (existingServers && LEGACY_MCP_KEY in existingServers) {
    const removeEdits = modify(content, ['amp.mcpServers', LEGACY_MCP_KEY], undefined, {
      formattingOptions: AMP_FORMATTING,
    });
    content = applyEdits(content, removeEdits);
  }
  const addEdits = modify(content, ['amp.mcpServers', MCP_KEY], value, {
    formattingOptions: AMP_FORMATTING,
  });
  const updated = applyEdits(content, addEdits);
  atomicWriteString(configPath, updated.endsWith('\n') ? updated : updated + '\n', {
    rejectSymlinks: true,
  });
  return isNew ? 'created' : 'updated';
}

// ---------------------------------------------------------------------------
// Factory Droid JSON writer (entries need `type: "stdio"`)
// ---------------------------------------------------------------------------

function factoryEntryMatches(
  configPath: string,
  expected: McpServerEntry & { type: 'stdio' },
): boolean {
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const servers = content?.mcpServers;
    // A lingering legacy key must force the write path (which deletes it) —
    // see entryMatches() above for why.
    if (servers && typeof servers === 'object' && LEGACY_MCP_KEY in servers) return false;
    const current = servers?.[MCP_KEY];
    if (!current || typeof current !== 'object') return false;
    if (current.type !== expected.type) return false;
    if (current.command !== expected.command) return false;
    if (JSON.stringify(current.args ?? []) !== JSON.stringify(expected.args)) return false;
    if ((current.cwd ?? undefined) !== (expected.cwd ?? undefined)) return false;
    return true;
  } catch {
    return false;
  }
}

function writeFactoryJsonEntry(
  configPath: string,
  entry: McpServerEntry & { type: 'stdio' },
): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let config: Record<string, unknown> = {};
  let isNew = true;
  // Atomic read: avoids TOCTOU between existsSync and readFileSync.
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    isNew = false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // malformed JSON — overwrite
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const servers = config.mcpServers as Record<string, unknown>;
  delete servers[LEGACY_MCP_KEY];
  servers[MCP_KEY] = entry;
  atomicWriteJson(configPath, config);
  return isNew ? 'created' : 'updated';
}

// ---------------------------------------------------------------------------
// TOML writer (Codex)
// ---------------------------------------------------------------------------

/**
 * Matches a `[mcp_servers.<key>]` header, including its `.env` sub-table.
 * `m` so `^` anchors to line starts when tested against full file content,
 * not just the single already-isolated lines stripCodexTomlSection tests.
 */
function codexSectionHeaderPattern(key: string): RegExp {
  return new RegExp(`^\\[mcp_servers\\s*\\.\\s*["']?${key}["']?(\\s*\\.[^\\]]*)?\\s*\\]`, 'm');
}

/**
 * Drop a `[mcp_servers.<key>]` section (and its `.env` sub-table, if any)
 * from raw TOML text. Codex config is append-only elsewhere in this file —
 * we never parse arbitrary TOML — so this is a narrowly-scoped line filter,
 * not a general TOML editor: it only recognizes section headers matching
 * `key` at the start of a line, which is exactly the shape writeCodexTomlEntry
 * itself always produces.
 */
function stripCodexTomlSection(content: string, key: string): string {
  const header = codexSectionHeaderPattern(key);
  const out: string[] = [];
  let skipping = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (header.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith('[')) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function writeCodexTomlEntry(configPath: string, entry: McpServerEntry): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const argsToml = entry.args.map((a) => `"${a}"`).join(', ');
  const section = [
    '',
    `[mcp_servers.${MCP_KEY}]`,
    `command = "${entry.command}"`,
    `args = [${argsToml}]`,
  ];
  if (entry.cwd) {
    section.push(`cwd = "${entry.cwd}"`);
  }
  if (entry.env) {
    section.push(`[mcp_servers.${MCP_KEY}.env]`);
    for (const [k, v] of Object.entries(entry.env)) {
      section.push(`${k} = "${v}"`);
    }
  }
  const block = `${section.join('\n')}\n`;

  let isNew = true;
  const existing = readIfExists(configPath);
  if (existing !== null) {
    isNew = false;
    // Strip both keys, not just the legacy one — a file that already has a
    // [mcp_servers.trace] section (interrupted prior migration, hand edit)
    // would otherwise keep it untouched and get a second, duplicate header
    // appended below, which is invalid TOML.
    const withoutExisting = stripCodexTomlSection(
      stripCodexTomlSection(existing, LEGACY_MCP_KEY),
      MCP_KEY,
    ).trimEnd();
    atomicWriteString(
      configPath,
      withoutExisting.length > 0 ? `${withoutExisting}\n${block}` : block.trimStart(),
      { rejectSymlinks: true },
    );
  } else {
    atomicWriteString(configPath, block.trimStart(), { rejectSymlinks: true });
  }

  return isNew ? 'created' : 'updated';
}

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

/** Get config file path for a client, given scope. */
// ---------------------------------------------------------------------------
// Status detection — used by `trace-mcp clients status` and the desktop app's
// MCP Clients screen. Tells you, for each client we know how to configure,
// whether the config file currently on disk has a trace-mcp entry that
// matches what `trace-mcp init` would write right now. The desktop app uses
// this to swap "Install" → "Update" when a field we manage has drifted —
// including a stale `alwaysLoad: true` left by a pre-#354 `init` run, which
// we now want stripped rather than reapplied.
// ---------------------------------------------------------------------------

/**
 * Per-client config status:
 * - `missing`      — config file or trace-mcp entry not present.
 * - `up_to_date`   — entry on disk equals what we'd write now.
 * - `stale`        — entry exists but a field we manage drifts (command path,
 *                    args, cwd, env, alwaysLoad). UI should show "Update".
 * - `unmanageable` — client doesn't expose a writable file (Warp,
 *                    JetBrains AI Assistant — IDE/cloud-managed config).
 * - `unknown`      — config exists but format is too lax to compare safely
 *                    (e.g. Codex TOML — we detect presence but not drift).
 */
export type ClientConfigStatus = 'missing' | 'up_to_date' | 'stale' | 'unmanageable' | 'unknown';

/**
 * Enforcement level a Claude-family config is on, as `init` installs it:
 * - `base`     — CLAUDE.md only, no hooks.
 * - `standard` — CLAUDE.md + hooks.
 * - `max`      — CLAUDE.md + hooks + tweakcc system prompts.
 */
export type EnforcementLevel = 'base' | 'standard' | 'max';

export interface McpClientStatus {
  client: DetectedMcpClient['name'];
  configPath: string | null;
  status: ClientConfigStatus;
  /** Short machine-friendly reason when `status === 'stale'` (e.g. "alwaysLoad"). */
  staleReason?: string;
  /**
   * Enforcement level the config on disk is currently on, so "Update" can
   * refresh a client without re-asking a setup question the user already
   * answered. `null` whenever the notion doesn't apply or can't be read: a
   * non-Claude client (no hooks/tweakcc to grade), or nothing configured yet
   * (`missing` / `unmanageable`) — where picking a level is a real choice.
   */
  level: EnforcementLevel | null;
}

/**
 * Where each Claude-family client keeps the settings.json that hooks are wired
 * into. Other clients don't run hooks, so they have no level.
 */
const CLAUDE_FAMILY_CONFIG_DIR: Partial<Record<DetectedMcpClient['name'], string>> = {
  'claude-code': '.claude',
  'claude-desktop': '.claude',
  'claw-code': '.claw',
};

/** Read back the level from the artifacts each level installs. */
function detectEnforcementLevel(name: DetectedMcpClient['name']): EnforcementLevel | null {
  const configDir = CLAUDE_FAMILY_CONFIG_DIR[name];
  if (!configDir) return null;
  if (!isGuardHookInstalled(configDir)) return 'base';
  return hasTweakccPrompts() ? 'max' : 'standard';
}

/** Every client we know how to surface in `clients status`. */
const ALL_MCP_CLIENT_NAMES: ReadonlyArray<DetectedMcpClient['name']> = [
  'claude-code',
  'claw-code',
  'claude-desktop',
  'cursor',
  'windsurf',
  'continue',
  'junie',
  'codex',
  'amp',
  'factory-droid',
  'hermes',
  'jetbrains-ai',
  'warp',
  'cline',
  'kilocode',
  'antigravity',
  'kimi',
];

/**
 * Clients whose config file is user-level no matter which scope was asked
 * for — `getConfigPath` ignores `projectRoot` for these, so a project-scoped
 * run would otherwise pin one project's path into a shared global file.
 */
const ALWAYS_GLOBAL_CLIENTS: ReadonlySet<DetectedMcpClient['name']> = new Set([
  'claude-desktop',
  'hermes',
  'cline',
  'kilocode',
  'antigravity',
  'kimi',
]);

/**
 * Build the entry we'd write for `name` right now. Single source of truth
 * shared by configureMcpClients() and getMcpClientStatuses() so drift
 * detection can never disagree with what init actually writes.
 *
 * A global registration deliberately carries NO `cwd` (TRA-501). `cwd` is the
 * working directory the client spawns `trace-mcp serve` in, and `serve` takes
 * whatever it is handed — so pinning it to `findProjectRoot(process.cwd())`
 * made the "correct" contents of a user-level entry depend on the directory
 * the CLI happened to run in: `clients status` reported `drift: cwd` from any
 * other directory, and a repair driven by the desktop app (which shells out
 * from the Electron bundle) wrote the app's own package directory into every
 * client. Without it the client's own working directory wins, which for an
 * editor is the project the user actually has open.
 */
function buildExpectedEntry(
  name: DetectedMcpClient['name'],
  projectRoot: string,
  scope: McpScope,
): McpServerEntry & { type?: 'stdio' } {
  const base: McpServerEntry = { ...buildMcpEntry(), args: ['serve'] };
  const effectiveScope: McpScope = ALWAYS_GLOBAL_CLIENTS.has(name) ? 'global' : scope;
  // claude-code/claw-code read a project-scoped config from the project root
  // itself, so they already run there — no cwd needed.
  if (effectiveScope === 'project' && name !== 'claude-code' && name !== 'claw-code') {
    base.cwd = projectRoot;
  }
  // alwaysLoad is intentionally never set here — see McpServerEntry.alwaysLoad.
  if (name === 'factory-droid') {
    return { type: 'stdio', ...base };
  }
  return base;
}

/**
 * Decide whether the on-disk entry for one client matches what we'd write.
 * Reuses the per-format matchers above (entryMatches / hermesEntryMatches /
 * ampEntryMatches / factoryEntryMatches) to avoid duplicating the
 * format-specific compare logic.
 */
function detectClientStatus(
  name: DetectedMcpClient['name'],
  projectRoot: string,
  scope: McpScope,
): Omit<McpClientStatus, 'level'> {
  if (name === 'jetbrains-ai' || name === 'warp') {
    return { client: name, configPath: null, status: 'unmanageable' };
  }
  const configPath = getConfigPath(name, projectRoot, scope);
  if (!configPath) {
    return { client: name, configPath: null, status: 'unmanageable' };
  }
  if (!fs.existsSync(configPath)) {
    return { client: name, configPath, status: 'missing' };
  }
  const expected = buildExpectedEntry(name, projectRoot, scope);

  switch (name) {
    case 'hermes': {
      const hermesEntry = expected as HermesYamlEntry;
      const present = (() => {
        try {
          const text = fs.readFileSync(configPath, 'utf-8');
          // Legacy-only counts as present (falls through to 'stale' below, not
          // 'missing') so `init` re-running migrates it rather than "installing".
          return /(^|\n)\s*(trace|trace-mcp)\s*:/.test(text);
        } catch {
          return false;
        }
      })();
      if (!present) return { client: name, configPath, status: 'missing' };
      return hermesEntryMatches(configPath, hermesEntry)
        ? { client: name, configPath, status: 'up_to_date' }
        : { client: name, configPath, status: 'stale', staleReason: 'fields' };
    }
    case 'amp': {
      const present = (() => {
        try {
          const text = fs.readFileSync(configPath, 'utf-8');
          return /["'](trace|trace-mcp)["']\s*:/.test(text);
        } catch {
          return false;
        }
      })();
      if (!present) return { client: name, configPath, status: 'missing' };
      return ampEntryMatches(configPath, expected as McpServerEntry)
        ? { client: name, configPath, status: 'up_to_date' }
        : { client: name, configPath, status: 'stale', staleReason: 'fields' };
    }
    case 'factory-droid': {
      const factoryEntry = expected as McpServerEntry & { type: 'stdio' };
      const present = (() => {
        try {
          const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          return Boolean(content?.mcpServers?.[MCP_KEY] ?? content?.mcpServers?.[LEGACY_MCP_KEY]);
        } catch {
          return false;
        }
      })();
      if (!present) return { client: name, configPath, status: 'missing' };
      return factoryEntryMatches(configPath, factoryEntry)
        ? { client: name, configPath, status: 'up_to_date' }
        : { client: name, configPath, status: 'stale', staleReason: 'fields' };
    }
    case 'codex': {
      // TOML — we only do presence detection, not drift, because writing the
      // section is append-based and we don't parse arbitrary TOML.
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const present =
          codexSectionHeaderPattern(MCP_KEY).test(content) ||
          codexSectionHeaderPattern(LEGACY_MCP_KEY).test(content);
        return {
          client: name,
          configPath,
          status: present ? 'unknown' : 'missing',
        };
      } catch {
        return { client: name, configPath, status: 'missing' };
      }
    }
    default: {
      // claude-code, claw-code, claude-desktop, cursor, windsurf, continue, junie,
      // cline, kilocode, antigravity, kimi all use the standard mcpServers JSON
      // shape compared by entryMatches().
      const present = (() => {
        try {
          const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          return Boolean(content?.mcpServers?.[MCP_KEY] ?? content?.mcpServers?.[LEGACY_MCP_KEY]);
        } catch {
          return false;
        }
      })();
      if (!present) return { client: name, configPath, status: 'missing' };
      if (entryMatches(configPath, expected as McpServerEntry)) {
        return { client: name, configPath, status: 'up_to_date' };
      }
      // Pinpoint the field that diverged so the UI can be specific.
      const reason = pinpointEntryDrift(configPath, expected as McpServerEntry);
      return { client: name, configPath, status: 'stale', staleReason: reason };
    }
  }
}

function pinpointEntryDrift(configPath: string, expected: McpServerEntry): string {
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const servers = content?.mcpServers;
    const current = servers?.[MCP_KEY];
    if (!current || typeof current !== 'object') {
      return servers?.[LEGACY_MCP_KEY] ? 'legacy-key' : 'entry-missing';
    }
    // The new key can be entirely correct on its own while a legacy key still
    // lingers alongside it (a previous run failed partway, or a config was
    // hand-edited) — that's still the reason to re-run, not a field mismatch.
    if (servers && typeof servers === 'object' && LEGACY_MCP_KEY in servers) return 'legacy-key';
    if (current.command !== expected.command) return 'command';
    if (JSON.stringify(current.args ?? []) !== JSON.stringify(expected.args)) return 'args';
    if ((current.cwd ?? undefined) !== (expected.cwd ?? undefined)) return 'cwd';
    if (
      (expected.env || current.env) &&
      JSON.stringify(current.env ?? {}) !== JSON.stringify(expected.env ?? {})
    ) {
      return 'env';
    }
    if ((current.alwaysLoad ?? false) !== (expected.alwaysLoad ?? false)) return 'alwaysLoad';
    return 'fields';
  } catch {
    return 'parse-error';
  }
}

/**
 * Generic per-client status report. Pass `clientNames` to limit the scan,
 * otherwise checks every client we know how to configure. Stable order
 * matches `ALL_MCP_CLIENT_NAMES` so the desktop app can render rows
 * deterministically.
 */
export function getMcpClientStatuses(
  projectRoot: string,
  scope: McpScope,
  clientNames?: DetectedMcpClient['name'][],
): McpClientStatus[] {
  const targets = clientNames ?? ALL_MCP_CLIENT_NAMES;
  return targets.map((name) => {
    const status = detectClientStatus(name, projectRoot, scope);
    // Nothing on disk yet means the level is still an open choice, not a fact
    // to report — only a configured client has one.
    const configured = status.status !== 'missing' && status.status !== 'unmanageable';
    return { ...status, level: configured ? detectEnforcementLevel(name) : null };
  });
}

function getConfigPath(
  name: DetectedMcpClient['name'],
  projectRoot: string,
  scope: McpScope,
): string | null {
  switch (name) {
    case 'claude-code':
      return scope === 'global'
        ? path.join(HOME, '.claude.json') // user-level MCP in Claude Code
        : path.join(projectRoot, '.mcp.json');
    case 'claw-code':
      return scope === 'global'
        ? path.join(HOME, '.claw', 'settings.json')
        : path.join(projectRoot, '.claw.json');
    case 'claude-desktop':
      // Claude Desktop is always global
      return process.platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(
            process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'),
            'Claude',
            'claude_desktop_config.json',
          );
    case 'cursor':
      return scope === 'global'
        ? path.join(HOME, '.cursor', 'mcp.json')
        : path.join(projectRoot, '.cursor', 'mcp.json');
    case 'windsurf':
      return scope === 'global'
        ? path.join(HOME, '.windsurf', 'mcp.json')
        : path.join(projectRoot, '.windsurf', 'mcp.json');
    case 'continue':
      return scope === 'global'
        ? path.join(HOME, '.continue', 'mcpServers', 'mcp.json')
        : path.join(projectRoot, '.continue', 'mcpServers', 'mcp.json');
    case 'junie':
      return scope === 'global'
        ? path.join(HOME, '.junie', 'mcp', 'mcp.json')
        : path.join(projectRoot, '.junie', 'mcp', 'mcp.json');
    case 'codex':
      return scope === 'global'
        ? path.join(HOME, '.codex', 'config.toml')
        : path.join(projectRoot, '.codex', 'config.toml');
    case 'jetbrains-ai':
      return null; // Configured through IDE Settings UI, not a file we can write
    case 'warp':
      return null; // Configured through Warp Settings UI; cloud-synced storage
    case 'amp': {
      const base =
        scope === 'global' ? path.join(HOME, '.config', 'amp') : path.join(projectRoot, '.amp');
      // Prefer existing .jsonc, fall back to .json. Otherwise create .json.
      const jsoncPath = path.join(base, 'settings.jsonc');
      const jsonPath = path.join(base, 'settings.json');
      if (fs.existsSync(jsoncPath)) return jsoncPath;
      if (fs.existsSync(jsonPath)) return jsonPath;
      return jsonPath;
    }
    case 'factory-droid':
      return scope === 'global'
        ? path.join(HOME, '.factory', 'mcp.json')
        : path.join(projectRoot, '.factory', 'mcp.json');
    case 'hermes':
      // Hermes Agent is always-global; project scope is a no-op here.
      return path.join(process.env.HERMES_HOME ?? path.join(HOME, '.hermes'), 'config.yaml');
    case 'cline':
      // Cline (VS Code extension saoudrizwan.claude-dev): standard mcpServers JSON,
      // global-only (lives in VS Code globalStorage, no per-project variant).
      // Source: cline_mcp_settings.json documented shape.
      return path.join(
        vscodeUserDir(),
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      );
    case 'kilocode':
      // KiloCode legacy VS Code extension (kilocode.kilo-code): standard mcpServers
      // JSON, global-only. The newer CLI (>= v7) uses a non-standard ~/.config/kilo/
      // kilo.jsonc shape we deliberately do not write; we target the standard
      // extension config only.
      return path.join(
        vscodeUserDir(),
        'globalStorage',
        'kilocode.kilo-code',
        'settings',
        'mcp_settings.json',
      );
    case 'antigravity':
      // Antigravity (Google agentic IDE): standard mcpServers JSON, global-only.
      // Source: ~/.gemini/config/mcp_config.json.
      return path.join(HOME, '.gemini', 'config', 'mcp_config.json');
    case 'kimi':
      // Kimi Code CLI (Moonshot): standard mcpServers JSON at ~/.kimi/mcp.json,
      // global-only. Source: https://moonshotai.github.io/kimi-cli/en/customization/mcp.html
      return path.join(HOME, '.kimi', 'mcp.json');
    default:
      return null;
  }
}

/**
 * VS Code User data dir — Cline and KiloCode (VS Code extensions) store their
 * MCP settings under globalStorage/<extension-id>/settings/ inside it. Verified
 * per-OS locations (mid-2026):
 *   macOS:   ~/Library/Application Support/Code/User
 *   Windows: %APPDATA%\Code\User
 *   Linux:   ~/.config/Code/User
 * Source: https://code.visualstudio.com/docs/getstarted/settings#_settings-file-locations
 */
function vscodeUserDir(): string {
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(HOME, '.config', 'Code', 'User');
}
