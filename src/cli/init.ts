/**
 * `trace-mcp init` command.
 * One-time global setup: configure MCP clients, install hooks, set up CLAUDE.md.
 * Does NOT add projects — use `trace-mcp add` for that.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { configureMcpClients } from '../init/mcp-client.js';
import { updateClaudeMd } from '../init/claude-md.js';
import { installGuardHook, installReindexHook, installPrecompactHook, installWorktreeHook } from '../init/hooks.js';
import { installCursorRules, installWindsurfRules } from '../init/ide-rules.js';
import { installTweakccPrompts, detectTweakccPrompts } from '../init/tweakcc.js';
import { formatReport } from '../init/reporter.js';
import { ensureGlobalDirs, getDbPath, GLOBAL_CONFIG_PATH } from '../global.js';
import { migrateGlobalConfig } from '../config-jsonc.js';
import type { DetectedMcpClient, InitStepResult, InitReport } from '../init/types.js';
import { detectMcpClients, detectGuardHook, detectProject } from '../init/detector.js';
import { detectConflicts } from '../init/conflict-detector.js';
import { fixAllConflicts } from '../init/conflict-resolver.js';
import { findProjectRoot, discoverChildProjects, hasRootMarkers } from '../project-root.js';
import { generateConfig } from '../init/config-generator.js';
import { registerProject, getProject, listProjects, updateLastIndexed, unregisterProject } from '../registry.js';
import { saveProjectConfig, removeProjectConfig, loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { setupProject } from '../project-setup.js';
import { Store } from '../db/store.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { createAllLanguagePlugins } from '../indexer/plugins/language/all.js';
import { createAllIntegrationPlugins } from '../indexer/plugins/integration/all.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { installGuiApp, isAppInstalled } from './install-app.js';

export const initCommand = new Command('init')
  .description('One-time global setup: configure MCP clients, install hooks, set up CLAUDE.md')
  .option('--yes', 'Skip prompts, use recommended defaults')
  .option('--skip-hooks', 'Do not install guard hooks')
  .option('--skip-mcp-client', 'Do not configure MCP client')
  .option('--skip-claude-md', 'Do not add CLAUDE.md block')
  .option('--mcp-client <name>', 'Force MCP client: claude-code | claude-desktop | cursor | windsurf | continue')
  .option('--force', 'Overwrite existing configuration')
  .option('--dry-run', 'Show what would be done without writing files')
  .option('--json', 'Output results as JSON (implies --yes)')
  .option('--index', 'Also register and index the current project')
  .action(async (opts: {
    yes?: boolean;
    skipHooks?: boolean;
    skipMcpClient?: boolean;
    skipClaudeMd?: boolean;
    mcpClient?: string;
    force?: boolean;
    dryRun?: boolean;
    json?: boolean;
    index?: boolean;
  }) => {
    const nonInteractive = opts.yes || opts.json || opts.dryRun;

    // Ensure global directory structure + migrate config
    let migrationStep: InitStepResult | undefined;
    if (!opts.dryRun) {
      ensureGlobalDirs();
      const migration = migrateGlobalConfig();
      if (migration.changed) {
        migrationStep = {
          target: '~/.trace-mcp/.config.json',
          action: 'updated',
          detail: `Config migrated — added: ${migration.added.join(', ')}`,
        };
      }
    }

    // Detect existing MCP clients and hook state
    const mcpClients = detectMcpClients();
    const { hasGuardHook, guardHookVersion } = detectGuardHook();

    // --- Interactive questions ---
    let selectedClients: DetectedMcpClient['name'][] = [];
    let installHooks = !opts.skipHooks;
    let claudeMdScope: 'global' | 'skip' = opts.skipClaudeMd ? 'skip' : 'global';
    let installTweakcc = false;
    let indexProject = opts.index ?? false;
    let fixConflicts = false;
    let installApp = false;

    if (!nonInteractive) {
      p.intro('trace-mcp init');
      p.note('Global one-time setup. Use `trace-mcp add` to register projects.', 'Info');

      // Q1: Which MCP clients
      if (!opts.skipMcpClient && !opts.mcpClient) {
        const allClients: DetectedMcpClient['name'][] = ['claude-code', 'claw-code', 'claude-desktop', 'cursor', 'windsurf', 'continue', 'junie', 'jetbrains-ai', 'codex'];
        const detectedNames = new Set(mcpClients.map((c) => c.name));

        const clientResult = await p.multiselect({
          message: 'MCP clients to configure (global)',
          options: allClients.map((name) => ({
            value: name,
            label: formatClientName(name),
            hint: detectedNames.has(name) ? 'detected' : undefined,
          })),
          initialValues: [...detectedNames].length > 0
            ? [...detectedNames]
            : ['claude-code'],
          required: true,
        });
        if (p.isCancel(clientResult)) { p.cancel('Cancelled.'); process.exit(0); }
        selectedClients = clientResult as DetectedMcpClient['name'][];
      }

      // Q2: Enforcement level (Claude Code only — hooks & tweakcc are CC-specific)
      const hasClaudeCode = selectedClients.includes('claude-code') || selectedClients.includes('claw-code') || selectedClients.includes('claude-desktop');

      if (hasClaudeCode && !opts.skipHooks) {
        const tweakccState = detectTweakccPrompts();

        const levelResult = await p.select({
          message: 'Enforcement level (Claude Code)',
          options: [
            {
              value: 'base' as const,
              label: 'Base — CLAUDE.md only',
              hint: 'soft routing rules in project instructions',
            },
            {
              value: 'standard' as const,
              label: 'Standard — CLAUDE.md + hooks',
              hint: 'guard hooks intercept tool calls at runtime (recommended)',
            },
            {
              value: 'max' as const,
              label: 'Max — CLAUDE.md + hooks + tweakcc',
              hint: tweakccState.installed
                ? 'patches Claude\'s system prompts (strongest)'
                : 'requires tweakcc — install with `npx tweakcc` first',
            },
          ],
          initialValue: 'standard' as const,
        });
        if (p.isCancel(levelResult)) { p.cancel('Cancelled.'); process.exit(0); }

        claudeMdScope = 'global';
        installHooks = levelResult === 'standard' || levelResult === 'max';
        installTweakcc = levelResult === 'max';
      } else {
        // Non-CC clients: always install CLAUDE.md, no hooks/tweakcc
        claudeMdScope = opts.skipClaudeMd ? 'skip' : 'global';
        installHooks = false;
        installTweakcc = false;
      }

      // Q4: Index current project
      if (!opts.index) {
        const indexResult = await p.confirm({
          message: 'Register and index current project?',
          initialValue: false,
        });
        if (p.isCancel(indexResult)) { p.cancel('Cancelled.'); process.exit(0); }
        indexProject = indexResult;
      }

      // Q5: Check for competing tools (only for selected clients)
      {
        let projectRoot: string | undefined;
        try { projectRoot = findProjectRoot(process.cwd()); } catch { /* no project */ }
        const conflictReport = detectConflicts(projectRoot);
        const clientSet = new Set(selectedClients);
        const fixable = conflictReport.conflicts.filter((c) => {
          if (!c.fixable) return false;
          if (c.category === 'mcp_server') {
            const clientName = c.id.split(':')[2];
            return clientSet.has(clientName);
          }
          return true;
        });
        if (fixable.length > 0) {
          const critical = fixable.filter((c) => c.severity === 'critical');
          const label = critical.length > 0
            ? `Found ${fixable.length} conflicting tool${fixable.length > 1 ? 's' : ''} (${critical.length} critical). Fix them? (recommended)`
            : `Found ${fixable.length} competing tool artifact${fixable.length > 1 ? 's' : ''}. Clean up?`;
          for (const c of fixable) {
            p.log.warn(`  ${c.summary}`);
          }
          const fixResult = await p.confirm({
            message: label,
            initialValue: true,
          });
          if (p.isCancel(fixResult)) { p.cancel('Cancelled.'); process.exit(0); }
          fixConflicts = fixResult;
        }
      }

      // Q6: Install menu bar app (macOS only)
      if (process.platform === 'darwin' && !isAppInstalled()) {
        const appResult = await p.confirm({
          message: 'Install trace-mcp menu bar app?',
          initialValue: true,
        });
        if (p.isCancel(appResult)) { p.cancel('Cancelled.'); process.exit(0); }
        installApp = appResult;
      }
    } else {
      // Non-interactive defaults
      if (opts.mcpClient) {
        selectedClients = [opts.mcpClient as DetectedMcpClient['name']];
      } else if (!opts.skipMcpClient) {
        selectedClients = ['claude-code'];
      }
      // Auto-fix conflicts in non-interactive mode
      fixConflicts = true;
    }

    // --- Execute ---
    const steps: InitStepResult[] = [];
    if (migrationStep) steps.push(migrationStep);

    if (!nonInteractive) {
      const spin = p.spinner();
      spin.start('Setting up trace-mcp');
      try {
        executeSteps(steps, { selectedClients, installHooks, installTweakcc, claudeMdScope, force: opts.force, dryRun: opts.dryRun });
      } catch (err) {
        spin.stop('Failed');
        p.log.error(`Setup failed: ${(err as Error).message}`);
        process.exit(1);
      }
      spin.stop('Done');
    } else {
      executeSteps(steps, { selectedClients, installHooks, installTweakcc, claudeMdScope, force: opts.force, dryRun: opts.dryRun });
    }

    // --- Fix competing tools ---
    if (fixConflicts) {
      try {
        let projectRoot: string | undefined;
        try { projectRoot = findProjectRoot(process.cwd()); } catch { /* no project */ }
        const conflictReport = detectConflicts(projectRoot);
        const clientSet = new Set(selectedClients);
        const fixable = conflictReport.conflicts.filter((c) => {
          if (!c.fixable) return false;
          // Only fix MCP server conflicts for clients the user selected
          if (c.category === 'mcp_server') {
            const clientName = c.id.split(':')[2]; // id format: "mcp:<server>:<client>:<path>"
            return clientSet.has(clientName);
          }
          return true;
        });
        if (fixable.length > 0) {
          const results = fixAllConflicts(fixable, { dryRun: opts.dryRun });
          for (const r of results) {
            if (r.action !== 'skipped') {
              steps.push({ target: r.target, action: 'updated', detail: `${r.action}: ${r.detail}` });
            }
          }
        }
      } catch (err) {
        if (!nonInteractive) {
          p.log.error(`Conflict resolution failed: ${(err as Error).message}`);
        } else {
          console.error(`Conflict resolution failed: ${(err as Error).message}`);
        }
      }
    }

    // --- Optional project indexing ---
    if (indexProject) {
      const spin = !nonInteractive ? p.spinner() : null;
      spin?.start('Registering and indexing current project...');
      const indexStep = await registerAndIndexProject(process.cwd(), { dryRun: opts.dryRun, force: opts.force });
      if (spin) {
        if (indexStep.detail?.includes('Indexed')) {
          spin.stop(indexStep.detail);
        } else {
          spin.stop(indexStep.detail ?? indexStep.action);
        }
      }
      steps.push(indexStep);
    }

    // --- Upgrade existing projects if previous installation detected ---
    const existingProjects = listProjects();
    if (existingProjects.length > 0) {
      let runUpgrade = false;

      if (!nonInteractive) {
        const upgradeResult = await p.confirm({
          message: `Found ${existingProjects.length} registered project${existingProjects.length > 1 ? 's' : ''} from a previous installation. Run upgrade (migrations + reindex)?`,
          initialValue: true,
        });
        if (p.isCancel(upgradeResult)) { p.cancel('Cancelled.'); process.exit(0); }
        runUpgrade = upgradeResult;
      } else {
        // Non-interactive: auto-upgrade
        runUpgrade = true;
      }

      if (runUpgrade) {
        const spin = !nonInteractive ? p.spinner() : null;
        spin?.start('Upgrading registered projects');

        for (const proj of existingProjects) {
          if (!fs.existsSync(proj.root)) {
            steps.push({ target: proj.root, action: 'skipped', detail: 'Directory not found (stale)' });
            continue;
          }

          if (opts.dryRun) {
            steps.push({ target: proj.root, action: 'skipped', detail: 'Would run migrations + reindex' });
            continue;
          }

          const configResult = await loadConfig(proj.root);
          if (configResult.isErr()) {
            steps.push({ target: proj.root, action: 'skipped', detail: 'Config load failed' });
            continue;
          }

          try {
            const dbPath = getDbPath(proj.root);
            const db = initializeDatabase(dbPath);
            const store = new Store(db);

            const registry = new PluginRegistry();
            for (const lp of createAllLanguagePlugins()) registry.registerLanguagePlugin(lp);
            for (const fp of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(fp);

            const pipeline = new IndexingPipeline(store, registry, configResult.value, proj.root);
            const result = await pipeline.indexAll(true);
            steps.push({
              target: proj.root, action: 'updated',
              detail: `Upgraded: ${result.indexed} files, ${result.skipped} skipped, ${result.errors} errors`,
            });
            updateLastIndexed(proj.root);
            db.close();
          } catch (err) {
            steps.push({ target: proj.root, action: 'skipped', detail: `Upgrade failed: ${(err as Error).message}` });
          }
        }

        spin?.stop('Upgrade complete');
      }
    }

    // --- Install menu bar app ---
    if (installApp && !opts.dryRun) {
      const spin = p.spinner();
      spin.start('Downloading trace-mcp menu bar app…');
      const appResult = await installGuiApp();
      if (appResult.installed) {
        spin.stop(`Installed → ${appResult.path}`);
        steps.push({ target: appResult.path!, action: 'created', detail: 'Menu bar app installed' });
      } else {
        spin.stop('App installation failed');
        p.log.warn(`Could not install app: ${appResult.error}`);
        steps.push({ target: '~/Applications/trace-mcp.app', action: 'skipped', detail: appResult.error ?? 'Installation failed' });
      }
    }

    // --- Report ---
    if (opts.json) {
      console.log(JSON.stringify({ steps }, null, 2));
    } else if (nonInteractive) {
      const header = opts.dryRun ? 'trace-mcp init (dry run)' : 'trace-mcp init';
      console.log(header);
      for (const step of steps) {
        console.log(`  ${shortPath(step.target)}  ${step.detail ?? step.action}`);
      }
      if (!opts.dryRun) {
        console.log('\n  Next: run `trace-mcp add` in a project directory to register it for indexing.\n');
      }
    } else {
      const created = steps.filter((s) => s.action === 'created' || s.action === 'updated');
      const skipped = steps.filter((s) => s.action === 'already_configured');

      if (created.length > 0) {
        const lines = created.map((s) => `  ${shortPath(s.target)}  ${s.detail ?? s.action}`);
        p.note(lines.join('\n'), 'Configured');
      }
      if (skipped.length > 0) {
        const lines = skipped.map((s) => `  ${shortPath(s.target)}  ${s.detail ?? ''}`);
        p.note(lines.join('\n'), 'Already configured');
      }

      p.outro(indexProject
        ? 'Ready! Project registered and indexed.'
        : 'Ready! Run `trace-mcp add` in a project directory to register it for indexing.',
      );
    }
  });

// --- Helpers ---

function executeSteps(
  steps: InitStepResult[],
  opts: {
    selectedClients: DetectedMcpClient['name'][];
    installHooks: boolean;
    installTweakcc: boolean;
    claudeMdScope: 'global' | 'skip';
    force?: boolean;
    dryRun?: boolean;
  },
) {
  // 1. MCP clients (always global)
  if (opts.selectedClients.length > 0) {
    const clientResults = configureMcpClients(opts.selectedClients, process.cwd(), {
      scope: 'global',
      dryRun: opts.dryRun,
    });
    steps.push(...clientResults);
  }

  // 2. IDE rules (Cursor .mdc, Windsurf .windsurfrules)
  if (opts.selectedClients.includes('cursor')) {
    steps.push(installCursorRules(process.cwd(), { dryRun: opts.dryRun, global: true }));
  }
  if (opts.selectedClients.includes('windsurf')) {
    steps.push(installWindsurfRules(process.cwd(), { dryRun: opts.dryRun, global: true }));
  }

  // 3. PreToolUse guard hook + PostToolUse auto-reindex hook
  if (opts.installHooks) {
    steps.push(installGuardHook({ global: true, dryRun: opts.dryRun }));
    steps.push(installReindexHook({ global: true, dryRun: opts.dryRun }));
    steps.push(installPrecompactHook({ global: true, dryRun: opts.dryRun }));
    steps.push(...installWorktreeHook({ global: true, dryRun: opts.dryRun }));
  }

  // 4. CLAUDE.md (global)
  if (opts.claudeMdScope === 'global') {
    const mdResult = updateClaudeMd(process.cwd(), {
      dryRun: opts.dryRun,
      scope: 'global',
    });
    steps.push(mdResult);
  }

  // 5. tweakcc system prompt rewrites
  if (opts.installTweakcc) {
    steps.push(...installTweakccPrompts({ dryRun: opts.dryRun }));
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function runIndexingForProject(projectRoot: string): Promise<{ indexed: number; skipped: number; errors: number; durationMs: number } | null> {
  const configResult = await loadConfig(projectRoot);
  if (configResult.isErr()) return null;

  const dbPath = getDbPath(projectRoot);
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = new PluginRegistry();
  for (const lp of createAllLanguagePlugins()) registry.registerLanguagePlugin(lp);
  for (const fp of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(fp);

  const pipeline = new IndexingPipeline(store, registry, configResult.value, projectRoot);
  try {
    const result = await pipeline.indexAll(true);
    updateLastIndexed(projectRoot);
    return { indexed: result.indexed, skipped: result.skipped, errors: result.errors, durationMs: result.durationMs };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function registerAndIndexProject(
  dir: string,
  opts: { dryRun?: boolean; force?: boolean },
): Promise<InitStepResult> {
  let projectRoot: string | null = null;
  const resolvedDir = path.resolve(dir);
  if (hasRootMarkers(resolvedDir)) {
    // Current directory has root markers — use it directly
    projectRoot = resolvedDir;
  } else {
    // No markers in current dir — only walk up if parent is already registered
    try {
      const parentRoot = findProjectRoot(resolvedDir);
      const parentEntry = getProject(parentRoot);
      if (parentEntry) {
        projectRoot = parentRoot;
      }
    } catch {
      // No root markers found anywhere up the tree
    }
  }

  // Multi-root fallback: discover child projects
  if (!projectRoot) {
    const childRoots = discoverChildProjects(dir);
    if (childRoots.length === 0) {
      return { target: dir, action: 'skipped', detail: 'Could not detect project root or child projects' };
    }
    return await registerMultiRootProject(dir, childRoots, opts);
  }

  if (opts.dryRun) {
    return { target: projectRoot, action: 'skipped', detail: 'Would register and index project' };
  }

  const existing = getProject(projectRoot);
  if (existing && !opts.force) {
    return { target: projectRoot, action: 'already_configured', detail: `Project already registered: ${existing.name}` };
  }

  const { entry } = setupProject(projectRoot, { force: opts.force, migrateOldDb: true });

  // Run indexing immediately
  const indexResult = await runIndexingForProject(projectRoot);
  const detail = indexResult
    ? `Registered and indexed: ${entry.name} — ${indexResult.indexed} files in ${formatDuration(indexResult.durationMs)} (${indexResult.skipped} skipped, ${indexResult.errors} errors)`
    : `Registered project: ${entry.name} (indexing failed)`;

  return {
    target: projectRoot,
    action: existing ? 'updated' : 'created',
    detail,
  };
}

async function registerMultiRootProject(
  parentDir: string,
  childRoots: string[],
  opts: { dryRun?: boolean; force?: boolean },
): Promise<InitStepResult> {
  if (opts.dryRun) {
    return {
      target: parentDir,
      action: 'skipped',
      detail: `Would register multi-root with ${childRoots.length} children: ${childRoots.map((r) => path.basename(r)).join(', ')}`,
    };
  }

  const existing = getProject(parentDir);
  if (existing && !opts.force) {
    return { target: parentDir, action: 'already_configured', detail: `Multi-root already registered: ${existing.name}` };
  }

  // Detect and merge configs from all children
  const allInclude: string[] = [];
  const allExclude: string[] = [];
  for (const childRoot of childRoots) {
    const relPath = path.relative(parentDir, childRoot).replace(/\\/g, '/');
    const detection = detectProject(childRoot);
    const config = generateConfig(detection);
    for (const pattern of config.include) allInclude.push(`${relPath}/${pattern}`);
    for (const pattern of config.exclude) allExclude.push(`${relPath}/${pattern}`);
  }

  // Cleanup existing child indexes
  const allProjects = listProjects();
  const parentPrefix = parentDir + path.sep;
  for (const proj of allProjects) {
    if (proj.root !== parentDir && proj.root.startsWith(parentPrefix)) {
      if (fs.existsSync(proj.dbPath)) fs.unlinkSync(proj.dbPath);
      unregisterProject(proj.root);
      removeProjectConfig(proj.root);
    }
  }

  // Save unified config
  saveProjectConfig(parentDir, {
    root: '.',
    include: allInclude,
    exclude: allExclude,
    children: childRoots,
  });

  const dbPath = getDbPath(parentDir);
  const db = initializeDatabase(dbPath);
  db.close();

  const entry = registerProject(parentDir, { type: 'multi-root', children: childRoots });

  // Run indexing immediately
  const indexResult = await runIndexingForProject(parentDir);
  const detail = indexResult
    ? `Registered and indexed multi-root: ${entry.name} (${childRoots.length} children) — ${indexResult.indexed} files in ${formatDuration(indexResult.durationMs)}`
    : `Registered multi-root (${childRoots.length} children): ${childRoots.map((r) => path.basename(r)).join(', ')} (indexing failed)`;

  return {
    target: parentDir,
    action: existing ? 'updated' : 'created',
    detail,
  };
}

function formatClientName(name: string): string {
  const names: Record<string, string> = {
    'claude-code': 'Claude Code',
    'claw-code': 'Claw Code',
    'claude-desktop': 'Claude Desktop',
    'cursor': 'Cursor',
    'windsurf': 'Windsurf',
    'continue': 'Continue',
    'junie': 'Junie',
    'jetbrains-ai': 'JetBrains AI Assistant',
    'codex': 'Codex',
  };
  return names[name] ?? name;
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  const cwd = process.cwd();
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1) || '.';
  return p;
}
