/**
 * Project detection: frameworks, languages, package managers, MCP clients, existing state.
 * Reuses buildProjectContext + PluginRegistry — no duplicated detection logic.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildProjectContext } from '../indexer/project-context.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import Database from 'better-sqlite3';
import type { DetectionResult, PackageManagerInfo, DetectedFramework, DetectedMcpClient } from './types.js';
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
    node: 'TypeScript', php: 'PHP', python: 'Python',
    ruby: 'Ruby', go: 'Go', java: 'Java', rust: 'Rust',
  };
  const languages = [...new Set(
    ctx.detectedVersions.map((v) => languageMap[v.runtime]).filter(Boolean),
  )];
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
  const hasClaudeMd = fs.existsSync(claudeMdPath);
  const claudeMdHasTraceMcpBlock = hasClaudeMd &&
    fs.readFileSync(claudeMdPath, 'utf-8').includes('<!-- trace-mcp:start -->');

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
    if (managers[managers.length - 1].lockfile === 'uv.lock') managers[managers.length - 1].type = 'uv';
    else if (!managers[managers.length - 1].lockfile && fs.existsSync(path.join(root, 'requirements.txt'))) {
      managers[managers.length - 1].type = 'pip';
    }
  }
  check('go.mod', 'go', ['go.sum']);
  check('Cargo.toml', 'cargo', ['Cargo.lock']);
  check('Gemfile', 'bundler', ['Gemfile.lock']);
  check('pom.xml', 'maven', []);
  if (!managers.some((m) => m.type === 'maven')) {
    if (fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts'))) {
      managers.push({ type: 'gradle', lockfile: undefined });
    }
  }
  return managers;
}

export function detectMcpClients(projectRoot?: string): DetectedMcpClient[] {
  const clients: DetectedMcpClient[] = [];

  const checkConfig = (name: DetectedMcpClient['name'], configPath: string) => {
    if (!fs.existsSync(configPath)) return;
    try {
      const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const hasTraceMcp = !!content?.mcpServers?.['trace-mcp'];
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
    checkConfig('claude-desktop', path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
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
    const jbConfigBase = platform === 'darwin'
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
      } catch { /* can't read dir */ }
    }
  }

  // Codex: global ~/.codex/config.toml, project .codex/config.toml
  {
    const checkToml = (name: DetectedMcpClient['name'], tomlPath: string) => {
      if (!fs.existsSync(tomlPath)) return;
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        const hasTraceMcp = /\[mcp_servers\s*\.\s*["']?trace-mcp["']?\s*\]/.test(content);
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

  return clients;
}

function detectExistingConfig(root: string): { path: string } | null {
  // Check dedicated config files
  const candidates = [
    path.join(root, '.trace-mcp.json'),
    path.join(root, '.config', 'trace-mcp.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { path: p };
  }
  // Check package.json "trace-mcp" field (cosmiconfig searches here too)
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg['trace-mcp']) return { path: pkgPath };
    } catch { /* ignore malformed package.json */ }
  }
  return null;
}

function detectExistingDb(root: string, globalDbPath?: string): { path: string; schemaVersion: number; fileCount: number } | null {
  // Check global location first, then legacy local location
  const candidates = globalDbPath
    ? [globalDbPath, path.join(root, '.trace-mcp', 'index.db')]
    : [path.join(root, '.trace-mcp', 'index.db')];
  const dbPath = candidates.find((p) => fs.existsSync(p));
  if (!dbPath) return null;
  try {
    // Open read-only — don't run migrations or log during detection
    const db = new Database(dbPath, { readonly: true });
    const versionRow = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    const schemaVersion = versionRow ? parseInt(versionRow.value, 10) : 0;
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number } | undefined;
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
  const existingPath = fs.existsSync(hookPath) ? hookPath : fs.existsSync(clawHookPath) ? clawHookPath : null;
  if (!existingPath) return { hasGuardHook: false, guardHookVersion: null };

  const content = fs.readFileSync(existingPath, 'utf-8');
  // Match both bash (# comment) and cmd (REM comment) version markers
  const match = content.match(/^(?:#|REM) trace-mcp-guard v(.+)$/m);
  return {
    hasGuardHook: true,
    guardHookVersion: match ? match[1] : null,
  };
}
