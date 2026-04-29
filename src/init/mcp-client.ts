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
import { getLauncherPath } from './launcher.js';
import type { DetectedMcpClient, InitStepResult } from './types.js';

const HOME = os.homedir();

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
   * Claude Code (and Claw) only: tells the host to skip ToolSearch deferral
   * and load every tool from this server into context at session start. We
   * set it during `trace-mcp init` because trace-mcp's value is in being
   * available from turn one — if our 128-tool surface lands behind a search
   * step, agents reach for native Bash/Grep before discovering the cheaper
   * trace-mcp equivalent. Documented at https://code.claude.com/docs/en/mcp
   * (mcpServers["..."].alwaysLoad).
   */
  alwaysLoad?: boolean;
}

/** Hosts that recognize the `alwaysLoad` flag in mcpServers entries. */
const ALWAYS_LOAD_CLIENTS: ReadonlySet<DetectedMcpClient['name']> = new Set([
  'claude-code',
  'claw-code',
]);

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
          : 'Add via Settings → Tools → AI Assistant → MCP → Add → Command: trace-mcp, Args: serve',
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
      const snippet = JSON.stringify({
        mcpServers: {
          'trace-mcp': { command: launcher, args: ['serve'], working_directory: projectRoot },
        },
      });
      results.push({
        target: 'Warp',
        action: 'skipped',
        detail: hasClaudeCode
          ? 'Enable Settings → Agents → MCP servers → "File-based MCP servers" to inherit trace-mcp from Claude Code, or paste: ' +
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
      const entry = { ...buildMcpEntry(), args: ['serve'], cwd: projectRoot };

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
      const entry: McpServerEntry & { type: 'stdio' } = {
        type: 'stdio',
        ...buildMcpEntry(),
        args: ['serve'],
        cwd: projectRoot,
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

      const entry = { ...buildMcpEntry(), args: ['serve'], cwd: projectRoot };

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

      // Check if already configured
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf-8');
          if (/\[mcp_servers\s*\.\s*["']?trace-mcp["']?\s*\]/.test(content)) {
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
        const action = writeCodexTomlEntry(configPath, {
          ...buildMcpEntry(),
          args: ['serve'],
          cwd: projectRoot,
        });
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
 * Verify that `mcpServers['trace-mcp']` is present on disk. Used after writing
 * Claude Desktop's config to detect the Claude.app overwrite race.
 */
function verifyTraceMcpEntry(configPath: string): boolean {
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return Boolean(content?.mcpServers?.['trace-mcp']);
  } catch {
    return false;
  }
}

function entryMatches(configPath: string, expected: McpServerEntry): boolean {
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const current = content?.mcpServers?.['trace-mcp'];
    if (!current || typeof current !== 'object') return false;
    if (current.command !== expected.command) return false;
    if (JSON.stringify(current.args ?? []) !== JSON.stringify(expected.args)) return false;
    if ((current.cwd ?? undefined) !== (expected.cwd ?? undefined)) return false;
    // env is optional — compare only if either side has it
    if (expected.env || current.env) {
      if (JSON.stringify(current.env ?? {}) !== JSON.stringify(expected.env ?? {})) return false;
    }
    // alwaysLoad must match — when we expect it set, an older entry without
    // it is stale and should be refreshed in place (no --force needed).
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
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      isNew = false;
    } catch {
      /* malformed — overwrite */
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>)['trace-mcp'] = entry;

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
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
    const current = servers?.['trace-mcp'] as Record<string, unknown> | undefined;
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
  if (fs.existsSync(configPath)) {
    isNew = false;
    doc = YAML.parseDocument(fs.readFileSync(configPath, 'utf-8'));
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
    // Hermes' own defaults are low — trace-mcp's first boot (indexing) can be slow.
    timeout: entry.timeout ?? 180,
    connect_timeout: entry.connect_timeout ?? 120,
  };

  doc.setIn(['mcp_servers', 'trace-mcp'], value);
  fs.writeFileSync(configPath, doc.toString({ lineWidth: 0 }));
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
    const current = servers?.['trace-mcp'] as Record<string, unknown> | undefined;
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
  const edits = modify(content, ['amp.mcpServers', 'trace-mcp'], value, {
    formattingOptions: AMP_FORMATTING,
  });
  const updated = applyEdits(content, edits);
  fs.writeFileSync(configPath, updated.endsWith('\n') ? updated : updated + '\n');
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
    const current = content?.mcpServers?.['trace-mcp'];
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
  (config.mcpServers as Record<string, unknown>)['trace-mcp'] = entry;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return isNew ? 'created' : 'updated';
}

// ---------------------------------------------------------------------------
// TOML writer (Codex)
// ---------------------------------------------------------------------------

function writeCodexTomlEntry(configPath: string, entry: McpServerEntry): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const argsToml = entry.args.map((a) => `"${a}"`).join(', ');
  const section = [
    '',
    '[mcp_servers.trace-mcp]',
    `command = "${entry.command}"`,
    `args = [${argsToml}]`,
  ];
  if (entry.cwd) {
    section.push(`cwd = "${entry.cwd}"`);
  }
  if (entry.env) {
    section.push('[mcp_servers.trace-mcp.env]');
    for (const [k, v] of Object.entries(entry.env)) {
      section.push(`${k} = "${v}"`);
    }
  }
  const block = `${section.join('\n')}\n`;

  let isNew = true;
  if (fs.existsSync(configPath)) {
    const existing = fs.readFileSync(configPath, 'utf-8');
    isNew = false;
    fs.writeFileSync(configPath, `${existing.trimEnd()}\n${block}`);
  } else {
    fs.writeFileSync(configPath, block.trimStart());
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
// this to swap "Install" → "Update" when a flag we now write (e.g.
// alwaysLoad) is missing from a previously-installed entry.
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

export interface McpClientStatus {
  client: DetectedMcpClient['name'];
  configPath: string | null;
  status: ClientConfigStatus;
  /** Short machine-friendly reason when `status === 'stale'` (e.g. "alwaysLoad"). */
  staleReason?: string;
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
];

/**
 * Build the entry we'd write for `name` right now. Single source of truth
 * shared by configureMcpClients() and getMcpClientStatuses() so drift
 * detection can never disagree with what init actually writes.
 */
function buildExpectedEntry(
  name: DetectedMcpClient['name'],
  projectRoot: string,
  scope: McpScope,
): McpServerEntry & { type?: 'stdio' } {
  const base: McpServerEntry = { ...buildMcpEntry(), args: ['serve'] };
  if (scope === 'global' || (name !== 'claude-code' && name !== 'claw-code')) {
    base.cwd = projectRoot;
  }
  if (ALWAYS_LOAD_CLIENTS.has(name)) {
    base.alwaysLoad = true;
  }
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
): McpClientStatus {
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
          return /(^|\n)\s*trace-mcp\s*:/.test(text);
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
          return /["']trace-mcp["']\s*:/.test(text);
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
          return Boolean(content?.mcpServers?.['trace-mcp']);
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
        const present = /\[mcp_servers\s*\.\s*["']?trace-mcp["']?\s*\]/.test(content);
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
      // claude-code, claw-code, claude-desktop, cursor, windsurf, continue, junie
      // all use the standard mcpServers JSON shape compared by entryMatches().
      const present = (() => {
        try {
          const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          return Boolean(content?.mcpServers?.['trace-mcp']);
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
    const current = content?.mcpServers?.['trace-mcp'];
    if (!current || typeof current !== 'object') return 'entry-missing';
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
  return targets.map((name) => detectClientStatus(name, projectRoot, scope));
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
    default:
      return null;
  }
}
