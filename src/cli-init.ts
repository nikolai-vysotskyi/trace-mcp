/**
 * `trace-mcp init` command.
 * One-time global setup: configure MCP clients, install hooks, set up CLAUDE.md.
 * Does NOT add projects — use `trace-mcp add` for that.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { configureMcpClients } from './init/mcp-client.js';
import { updateClaudeMd } from './init/claude-md.js';
import { installGuardHook } from './init/hooks.js';
import { installCursorRules, installWindsurfRules } from './init/ide-rules.js';
import { formatReport } from './init/reporter.js';
import { ensureGlobalDirs, getDbPath } from './global.js';
import type { DetectedMcpClient, InitStepResult, InitReport } from './init/types.js';
import { detectMcpClients, detectGuardHook, detectProject } from './init/detector.js';
import { findProjectRoot } from './project-root.js';
import { generateConfig } from './init/config-generator.js';
import { registerProject, getProject } from './registry.js';
import { saveProjectConfig } from './config.js';
import { initializeDatabase } from './db/schema.js';

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

    // Ensure global directory structure
    if (!opts.dryRun) {
      ensureGlobalDirs();
    }

    // Detect existing MCP clients and hook state
    const mcpClients = detectMcpClients();
    const { hasGuardHook, guardHookVersion } = detectGuardHook();

    // --- Interactive questions ---
    let selectedClients: DetectedMcpClient['name'][] = [];
    let installHooks = !opts.skipHooks;
    let claudeMdScope: 'global' | 'skip' = opts.skipClaudeMd ? 'skip' : 'global';
    let indexProject = opts.index ?? false;

    if (!nonInteractive) {
      p.intro('trace-mcp init');
      p.note('Global one-time setup. Use `trace-mcp add` to register projects.', 'Info');

      // Q1: Which MCP clients
      if (!opts.skipMcpClient && !opts.mcpClient) {
        const allClients: DetectedMcpClient['name'][] = ['claude-code', 'claude-desktop', 'cursor', 'windsurf', 'continue'];
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

      // Q2: Guard hook
      if (!opts.skipHooks) {
        const hookResult = await p.confirm({
          message: 'Install guard hook? (blocks Read/Grep/Glob on code files, redirects to trace-mcp)',
          initialValue: true,
        });
        if (p.isCancel(hookResult)) { p.cancel('Cancelled.'); process.exit(0); }
        installHooks = hookResult;
      }

      // Q3: CLAUDE.md
      if (!opts.skipClaudeMd) {
        const mdResult = await p.confirm({
          message: 'Add tool routing guide to ~/.claude/CLAUDE.md?',
          initialValue: true,
        });
        if (p.isCancel(mdResult)) { p.cancel('Cancelled.'); process.exit(0); }
        claudeMdScope = mdResult ? 'global' : 'skip';
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
    } else {
      // Non-interactive defaults
      if (opts.mcpClient) {
        selectedClients = [opts.mcpClient as DetectedMcpClient['name']];
      } else if (!opts.skipMcpClient) {
        selectedClients = ['claude-code'];
      }
    }

    // --- Execute ---
    const steps: InitStepResult[] = [];

    if (!nonInteractive) {
      const spin = p.spinner();
      spin.start('Setting up trace-mcp');
      executeSteps(steps, { selectedClients, installHooks, claudeMdScope, force: opts.force, dryRun: opts.dryRun });
      spin.stop('Done');
    } else {
      executeSteps(steps, { selectedClients, installHooks, claudeMdScope, force: opts.force, dryRun: opts.dryRun });
    }

    // --- Optional project indexing ---
    if (indexProject) {
      const indexStep = registerAndIndexProject(process.cwd(), { dryRun: opts.dryRun, force: opts.force });
      steps.push(indexStep);
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
        ? 'Ready! Project registered and will be indexed when trace-mcp serve starts.'
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

  // 3. Guard hook
  if (opts.installHooks) {
    const hookResult = installGuardHook({
      global: true,
      dryRun: opts.dryRun,
    });
    steps.push(hookResult);
  }

  // 4. CLAUDE.md (global)
  if (opts.claudeMdScope === 'global') {
    const mdResult = updateClaudeMd(process.cwd(), {
      dryRun: opts.dryRun,
      scope: 'global',
    });
    steps.push(mdResult);
  }
}

function registerAndIndexProject(
  dir: string,
  opts: { dryRun?: boolean; force?: boolean },
): InitStepResult {
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot(dir);
  } catch {
    return { target: dir, action: 'skipped', detail: 'Could not detect project root' };
  }

  if (opts.dryRun) {
    return { target: projectRoot, action: 'skipped', detail: 'Would register and index project' };
  }

  const existing = getProject(projectRoot);
  if (existing && !opts.force) {
    return { target: projectRoot, action: 'already_configured', detail: `Project already registered: ${existing.name}` };
  }

  const detection = detectProject(projectRoot);
  const config = generateConfig(detection);
  saveProjectConfig(projectRoot, { root: config.root, include: config.include, exclude: config.exclude });

  const dbPath = getDbPath(projectRoot);

  // Migrate old local DB if it exists
  const oldDbPath = path.join(projectRoot, '.trace-mcp', 'index.db');
  if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
    fs.copyFileSync(oldDbPath, dbPath);
  }

  const db = initializeDatabase(dbPath);
  db.close();

  const entry = registerProject(projectRoot);
  return {
    target: projectRoot,
    action: existing ? 'updated' : 'created',
    detail: `Registered project: ${entry.name}`,
  };
}

function formatClientName(name: string): string {
  const names: Record<string, string> = {
    'claude-code': 'Claude Code',
    'claude-desktop': 'Claude Desktop',
    'cursor': 'Cursor',
    'windsurf': 'Windsurf',
    'continue': 'Continue',
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
