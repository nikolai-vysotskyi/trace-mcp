/**
 * Project detection: frameworks, languages, package managers, MCP clients, existing state.
 * Reuses buildProjectContext + PluginRegistry — no duplicated detection logic.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { buildProjectContext } from '../indexer/project-context.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { readIfExists } from '../utils/safe-fs.js';
import Database from 'better-sqlite3';
import type {
  DetectionResult,
  PackageManagerInfo,
  DetectedFramework,
  DetectedMcpClient,
} from './types.js';
import { GUARD_HOOK_VERSION } from './types.js';

const HOME = os.homedir();

/** Detect everything about the project for init/upgrade. */
export function detectProject(dir: string): DetectionResult {
  const projectRoot = path.resolve(dir);
  const ctx = buildProjectContext(projectRoot);

  // --- Package managers ---
  const packageManagers = detectPackageManagers(projectRoot);

  // --- Frameworks via plugin registry ---
  const registry = PluginRegistry.createWithDefaults();

  const activeResult = registry.getActiveFrameworkPlugins(ctx);
  const frameworks: DetectedFramework[] = activeResult.isOk()
    ? activeResult.value.map((p) => {
        const dep = ctx.allDependencies.find((d) => d.name === p.manifest.name);
        return { name: p.manifest.name, version: dep?.version, category: p.manifest.category };
      })
    : [];

  // --- Languages from detected versions ---
  const languageMap: Record<string, string> = {
    node: 'TypeScript',
    php: 'PHP',
    python: 'Python',
    ruby: 'Ruby',
    go: 'Go',
    java: 'Java',
    rust: 'Rust',
  };
  const languages = [
    ...new Set(ctx.detectedVersions.map((v) => languageMap[v.runtime]).filter(Boolean)),
  ];
  // Add Vue if .vue files or Vue frameworks detected
  if (frameworks.some((f) => ['vue', 'nuxt', 'inertia'].includes(f.name))) {
    if (!languages.includes('Vue')) languages.push('Vue');
  }

  // --- MCP clients ---
  const mcpClients = detectMcpClients(projectRoot);

  // --- Existing state ---
  const existingConfig = detectExistingConfig(projectRoot);
  const existingDb = detectExistingDb(projectRoot);
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  const claudeMdContent = readIfExists(claudeMdPath);
  const hasClaudeMd = claudeMdContent !== null;
  const claudeMdHasTraceMcpBlock =
    claudeMdContent !== null &&
    (claudeMdContent.includes('<!-- trace:start -->') ||
      claudeMdContent.includes('<!-- trace-mcp:start -->'));

  const { hasGuardHook, guardHookVersion } = detectGuardHook();

  return {
    projectRoot,
    packageManagers,
    frameworks,
    languages,
    mcpClients,
    existingConfig,
    existingDb,
    hasClaudeMd,
    claudeMdHasTraceMcpBlock,
    hasGuardHook,
    guardHookVersion,
  };
}

function detectPackageManagers(root: string): PackageManagerInfo[] {
  const managers: PackageManagerInfo[] = [];
  const check = (file: string, type: PackageManagerInfo['type'], lockfiles: string[]) => {
    if (fs.existsSync(path.join(root, file))) {
      const lockfile = lockfiles.find((l) => fs.existsSync(path.join(root, l)));
      managers.push({ type, lockfile });
    }
  };
  check('package.json', 'npm', ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);
  // Refine npm → yarn/pnpm/bun based on lockfile
  if (managers.length > 0 && managers[0].type === 'npm') {
    if (managers[0].lockfile === 'yarn.lock') managers[0].type = 'yarn';
    else if (managers[0].lockfile === 'pnpm-lock.yaml') managers[0].type = 'pnpm';
    else if (managers[0].lockfile === 'bun.lockb') managers[0].type = 'bun';
  }
  check('composer.json', 'composer', ['composer.lock']);
  check('pyproject.toml', 'poetry', ['poetry.lock', 'uv.lock']);
  if (managers.length > 0 && managers[managers.length - 1].type === 'poetry') {
    if (managers[managers.length - 1].lockfile === 'uv.lock')
      managers[managers.length - 1].type = 'uv';
    else if (
      !managers[managers.length - 1].lockfile &&
      fs.existsSync(path.join(root, 'requirements.txt'))
    ) {
      managers[managers.length - 1].type = 'pip';
    }
  }
  check('go.mod', 'go', ['go.sum']);
  check('Cargo.toml', 'cargo', ['Cargo.lock']);
  check('Gemfile', 'bundler', ['Gemfile.lock']);
  check('pom.xml', 'maven', []);
  if (!managers.some((m) => m.type === 'maven')) {
    if (
      fs.existsSync(path.join(root, 'build.gradle')) ||
      fs.existsSync(path.join(root, 'build.gradle.kts'))
    ) {
      managers.push({ type: 'gradle', lockfile: undefined });
    }
  }
  return managers;
}

export function detectMcpClients(projectRoot?: string): DetectedMcpClient[] {
  const clients: DetectedMcpClient[] = [];

  const checkConfig = (name: DetectedMcpClient['name'], configPath: string) => {
    try {
      const raw = readIfExists(configPath);
      if (raw === null) return;
      const content = JSON.parse(raw);
      const hasTraceMcp = !!(content?.mcpServers?.trace || content?.mcpServers?.['trace-mcp']);
      clients.push({ name, configPath, hasTraceMcp });
    } catch {
      // Malformed JSON — still report as detected but without trace-mcp
      clients.push({ name, configPath, hasTraceMcp: false });
    }
  };

  // Claude Code: project-level .mcp.json (only if projectRoot given)
  if (projectRoot) {
    checkConfig('claude-code', path.join(projectRoot, '.mcp.json'));
  }
  // Claude Code: global — mcpServers can live in either file
  checkConfig('claude-code', path.join(HOME, '.claude.json'));
  checkConfig('claude-code', path.join(HOME, '.claude', 'settings.json'));

  // Claw Code: project-level .claw.json
  if (projectRoot) {
    checkConfig('claw-code', path.join(projectRoot, '.claw.json'));
  }
  // Claw Code: global settings
  checkConfig('claw-code', path.join(HOME, '.claw', 'settings.json'));

  // Claude Desktop
  const platform = os.platform();
  if (platform === 'darwin') {
    checkConfig(
      'claude-desktop',
      path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
    checkConfig('claude-desktop', path.join(appData, 'Claude', 'claude_desktop_config.json'));
  }

  // Cursor: global first, then project-level
  checkConfig('cursor', path.join(HOME, '.cursor', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'cursor')) {
    checkConfig('cursor', path.join(projectRoot, '.cursor', 'mcp.json'));
  }

  // Windsurf: global first, then project-level
  checkConfig('windsurf', path.join(HOME, '.windsurf', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'windsurf')) {
    checkConfig('windsurf', path.join(projectRoot, '.windsurf', 'mcp.json'));
  }

  // Continue: global mcpServers dir first, then project-level
  checkConfig('continue', path.join(HOME, '.continue', 'mcpServers', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'continue')) {
    checkConfig('continue', path.join(projectRoot, '.continue', 'mcpServers', 'mcp.json'));
  }

  // Junie: global ~/.junie/mcp/mcp.json, project .junie/mcp/mcp.json
  checkConfig('junie', path.join(HOME, '.junie', 'mcp', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'junie')) {
    checkConfig('junie', path.join(projectRoot, '.junie', 'mcp', 'mcp.json'));
  }

  // JetBrains AI Assistant: detect via IDE mcpServer.xml in JetBrains config dirs
  {
    const jbConfigBase =
      platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'JetBrains')
        : platform === 'win32'
          ? path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'JetBrains')
          : path.join(HOME, '.config', 'JetBrains');

    if (fs.existsSync(jbConfigBase)) {
      try {
        const dirs = fs.readdirSync(jbConfigBase);
        for (const dir of dirs) {
          const mcpXml = path.join(jbConfigBase, dir, 'options', 'mcpServer.xml');
          if (fs.existsSync(mcpXml)) {
            // Found at least one JetBrains IDE with MCP support
            clients.push({ name: 'jetbrains-ai', configPath: mcpXml, hasTraceMcp: false });
            break;
          }
        }
      } catch {
        /* can't read dir */
      }
    }
  }

  // Codex: global ~/.codex/config.toml, project .codex/config.toml
  {
    const checkToml = (name: DetectedMcpClient['name'], tomlPath: string) => {
      try {
        const content = readIfExists(tomlPath);
        if (content === null) return;
        const hasTraceMcp = /\[mcp_servers\s*\.\s*["']?trace(?:-mcp)?["']?\s*\]/.test(content);
        clients.push({ name, configPath: tomlPath, hasTraceMcp });
      } catch {
        clients.push({ name, configPath: tomlPath, hasTraceMcp: false });
      }
    };

    checkToml('codex', path.join(HOME, '.codex', 'config.toml'));
    if (projectRoot && !clients.some((c) => c.name === 'codex')) {
      checkToml('codex', path.join(projectRoot, '.codex', 'config.toml'));
    }
  }

  // AMP (Sourcegraph): JSON/JSONC at ~/.config/amp/settings.json[c],
  // workspace at .amp/settings.json[c]. Top-level key is `amp.mcpServers`
  // (note the literal dot in the key name — flat key, not nested under `amp`).
  {
    const checkAmp = (configPath: string) => {
      try {
        const content = readIfExists(configPath);
        if (content === null) return;
        const parsed = parseJsonc(content) as Record<string, unknown> | null;
        const servers = parsed?.['amp.mcpServers'] as Record<string, unknown> | undefined;
        const hasTraceMcp = !!(servers?.trace || servers?.['trace-mcp']);
        clients.push({ name: 'amp', configPath, hasTraceMcp });
      } catch {
        clients.push({ name: 'amp', configPath, hasTraceMcp: false });
      }
    };
    const ampUserBase = path.join(HOME, '.config', 'amp');
    for (const file of ['settings.jsonc', 'settings.json']) {
      const p = path.join(ampUserBase, file);
      if (fs.existsSync(p)) {
        checkAmp(p);
        break;
      }
    }
    if (projectRoot && !clients.some((c) => c.name === 'amp')) {
      const ampProjectBase = path.join(projectRoot, '.amp');
      for (const file of ['settings.jsonc', 'settings.json']) {
        const p = path.join(ampProjectBase, file);
        if (fs.existsSync(p)) {
          checkAmp(p);
          break;
        }
      }
    }
  }

  // Factory Droid: JSON at ~/.factory/mcp.json (user) or .factory/mcp.json (project).
  // Standard `mcpServers` key, but each entry has `type: "stdio"|"http"`.
  checkConfig('factory-droid', path.join(HOME, '.factory', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'factory-droid')) {
    checkConfig('factory-droid', path.join(projectRoot, '.factory', 'mcp.json'));
  }

  // Warp: configuration is stored in cloud-synced storage, not a writable file.
  // We only detect installation presence so the UI can offer a paste-snippet flow.
  {
    const warpPaths =
      platform === 'darwin'
        ? ['/Applications/Warp.app', path.join(HOME, 'Applications', 'Warp.app')]
        : platform === 'win32'
          ? [
              path.join(
                process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local'),
                'Programs',
                'Warp',
              ),
            ]
          : [path.join(HOME, '.local', 'share', 'warp-terminal'), '/usr/bin/warp-terminal'];
    const installed = warpPaths.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (installed) {
      clients.push({
        name: 'warp',
        configPath: '<Warp Settings → Agents → MCP servers>',
        hasTraceMcp: false,
      });
    }
  }

  // Hermes Agent: always-global YAML config at ~/.hermes/config.yaml (or $HERMES_HOME).
  // Detect by looking for an `mcp_servers:` mapping with a `trace:` or `trace-mcp:` child.
  // Use regex rather than a full YAML parse so detection doesn't bring a parser
  // onto the hot path.
  {
    const hermesHome = process.env.HERMES_HOME ?? path.join(HOME, '.hermes');
    const yamlPath = path.join(hermesHome, 'config.yaml');
    try {
      const content = readIfExists(yamlPath);
      if (content !== null) {
        // Match: `mcp_servers:` (top level) then indented `trace:` or `trace-mcp:` entry
        const hasTraceMcp = /^mcp_servers\s*:\s*$[\s\S]*?^\s+trace(?:-mcp)?\s*:/m.test(content);
        clients.push({ name: 'hermes', configPath: yamlPath, hasTraceMcp });
      }
    } catch {
      clients.push({ name: 'hermes', configPath: yamlPath, hasTraceMcp: false });
    }
  }

  // VS Code User data dir — Cline and KiloCode (VS Code extensions) both keep
  // their MCP settings under globalStorage/<extension-id>/settings/ inside it.
  // Verified paths (mid-2026):
  //   macOS:   ~/Library/Application Support/Code/User
  //   Windows: %APPDATA%\Code\User
  //   Linux:   ~/.config/Code/User
  // Source: https://code.visualstudio.com/docs/getstarted/settings#_settings-file-locations
  const vscodeUserDir =
    platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support', 'Code', 'User')
      : platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User')
        : path.join(HOME, '.config', 'Code', 'User');

  // Cline (saoudrizwan.claude-dev): standard `mcpServers` JSON at
  // globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json.
  // Global-only (VS Code globalStorage has no per-project variant). We only
  // report it as detected when the extension's settings dir exists, to avoid
  // surfacing a client the user hasn't installed.
  // Source: https://docs.cline.bot / cline_mcp_settings.json documented shape.
  {
    const clineDir = path.join(
      vscodeUserDir,
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
    );
    if (fs.existsSync(clineDir)) {
      checkConfig('cline', path.join(clineDir, 'cline_mcp_settings.json'));
    }
  }

  // KiloCode (kilocode.kilo-code): legacy VS Code extension format uses standard
  // `mcpServers` JSON at globalStorage/kilocode.kilo-code/settings/mcp_settings.json.
  // Global-only. NOTE: KiloCode >= v7 (CLI) migrated to a non-standard shape at
  // ~/.config/kilo/kilo.jsonc (top-level `mcp` key, `command` as array,
  // `type: local`). We target only the standard-shape legacy extension config
  // here — detection is gated on the extension's settings dir existing.
  // Sources: https://github.com/Kilo-Org/kilocode-legacy/blob/main/docs/file-locations.md
  //          https://github.com/Kilo-Org/kilocode/issues/6481
  {
    const kiloDir = path.join(vscodeUserDir, 'globalStorage', 'kilocode.kilo-code', 'settings');
    if (fs.existsSync(kiloDir)) {
      checkConfig('kilocode', path.join(kiloDir, 'mcp_settings.json'));
    }
  }

  // Antigravity (Google's agentic IDE, Windsurf lineage): standard `mcpServers`
  // JSON at ~/.gemini/config/mcp_config.json. Global-only (no documented
  // per-project config as of mid-2026).
  // Source: https://medium.com/google-cloud/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-a938c7eebb78
  checkConfig('antigravity', path.join(HOME, '.gemini', 'config', 'mcp_config.json'));

  // Kimi Code CLI (Moonshot): standard `mcpServers` JSON at ~/.kimi/mcp.json,
  // "compatible with other MCP clients". Global-only.
  // Source: https://moonshotai.github.io/kimi-cli/en/customization/mcp.html
  checkConfig('kimi', path.join(HOME, '.kimi', 'mcp.json'));

  return clients;
}

function detectExistingConfig(root: string): { path: string } | null {
  // Check dedicated config files (.trace.json takes precedence over legacy .trace-mcp.json)
  const candidates = [
    path.join(root, '.trace.json'),
    path.join(root, '.trace-mcp.json'),
    path.join(root, '.config', 'trace.json'),
    path.join(root, '.config', 'trace-mcp.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { path: p };
  }
  // Check package.json "trace" or "trace-mcp" field (cosmiconfig searches here too)
  const pkgPath = path.join(root, 'package.json');
  const pkgRaw = readIfExists(pkgPath);
  if (pkgRaw !== null) {
    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg.trace || pkg['trace-mcp']) return { path: pkgPath };
    } catch {
      /* ignore malformed package.json */
    }
  }
  return null;
}

function detectExistingDb(
  root: string,
  globalDbPath?: string,
): { path: string; schemaVersion: number; fileCount: number } | null {
  // Check global location first, then local locations
  const candidates = globalDbPath
    ? [
        globalDbPath,
        path.join(root, '.trace', 'index.db'),
        path.join(root, '.trace-mcp', 'index.db'),
      ]
    : [path.join(root, '.trace', 'index.db'), path.join(root, '.trace-mcp', 'index.db')];
  const dbPath = candidates.find((p) => fs.existsSync(p));
  if (!dbPath) return null;
  try {
    // Open read-only — don't run migrations or log during detection
    const db = new Database(dbPath, { readonly: true });
    const versionRow = db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    const schemaVersion = versionRow ? parseInt(versionRow.value, 10) : 0;
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM files').get() as
      | { cnt: number }
      | undefined;
    const fileCount = countRow?.cnt ?? 0;
    db.close();
    return { path: dbPath, schemaVersion, fileCount };
  } catch {
    return { path: dbPath, schemaVersion: 0, fileCount: 0 };
  }
}

export function detectGuardHook(): { hasGuardHook: boolean; guardHookVersion: string | null } {
  const ext = process.platform === 'win32' ? '.cmd' : '.sh';
  const hookPath = path.join(HOME, '.claude', 'hooks', `trace-mcp-guard${ext}`);
  const clawHookPath = path.join(HOME, '.claw', 'hooks', `trace-mcp-guard${ext}`);
  const content = readIfExists(hookPath) ?? readIfExists(clawHookPath);
  if (content === null) return { hasGuardHook: false, guardHookVersion: null };

  // Match both bash (# comment) and cmd (REM comment) version markers
  const match = content.match(/^(?:#|REM) trace-mcp-guard v(.+)$/m);
  return {
    hasGuardHook: true,
    guardHookVersion: match ? match[1] : null,
  };
}
