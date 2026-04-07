/**
 * MCP Prompts — pre-built workflow templates for common development tasks.
 *
 * Each prompt orchestrates multiple trace-mcp tools into a structured report
 * that the AI agent can use as context for its response.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Store } from '../db/store.js';
import { getChangeImpact } from '../tools/analysis/impact.js';
import { getFeatureContext } from '../tools/navigation/context.js';
import { getProjectMap } from '../tools/project/project.js';
import { buildProjectContext } from '../indexer/project-context.js';
import { getCallGraph } from '../tools/framework/call-graph.js';
import { getCouplingMetrics, getDependencyCycles, getRepoHealth } from '../tools/analysis/graph-analysis.js';
import { getDeadCodeV2 } from '../tools/refactoring/dead-code.js';
import { getHotspots } from '../tools/git/git-analysis.js';
import { predictBugs, getTechDebt } from '../tools/analysis/predictive-intelligence.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';

interface PromptContext {
  store: Store;
  registry: PluginRegistry;
  config: TraceMcpConfig;
  projectRoot: string;
}

/** Safe wrapper — prompts must never crash, just skip sections on error */
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function registerPrompts(server: McpServer, ctx: PromptContext): void {
  const { store, registry, config, projectRoot } = ctx;

  // --- 1. Review Prompt ---
  server.prompt(
    'review',
    'Comprehensive PR review: changed files impact, blast radius, test gaps, architecture check',
    {
      branch: z.string().describe('Feature branch name (compared against HEAD~N or base)'),
      base: z.string().optional().describe('Base branch or ref (default: HEAD~1)'),
    },
    async ({ branch, base }) => {
      const baseRef = base ?? 'HEAD~1';
      const sections: string[] = [];

      sections.push(`# PR Review: ${branch} vs ${baseRef}\n`);

      // 1. Get changed files from git
      let changedFiles: string[] = [];
      try {
        const { execFileSync } = await import('node:child_process');
        const diff = execFileSync('git', ['diff', '--name-only', `${baseRef}...${branch}`], {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        changedFiles = diff ? diff.split('\n').filter(Boolean) : [];
      } catch {
        changedFiles = [];
        sections.push('> Could not determine changed files via git diff.\n');
      }

      if (changedFiles.length > 0) {
        sections.push(`## Changed Files (${changedFiles.length})\n`);
        for (const f of changedFiles.slice(0, 30)) {
          sections.push(`- ${f}`);
        }
        if (changedFiles.length > 30) {
          sections.push(`- ... and ${changedFiles.length - 30} more`);
        }
        sections.push('');

        // 2. Impact analysis for top changed files (limit to avoid N+1)
        const impactFiles = changedFiles.slice(0, 5);
        const impacts: string[] = [];
        for (const f of impactFiles) {
          const result = getChangeImpact(store, { filePath: f }, 2, 50);
          if (result.isOk()) {
            const v = result.value;
            const depCount = Array.isArray(v.dependents) ? v.dependents.length : 0;
            if (depCount > 0) {
              impacts.push(`- **${f}**: ${depCount} dependent(s)`);
            }
          }
        }
        if (impacts.length > 0) {
          sections.push('## Impact Analysis\n');
          sections.push(...impacts);
          sections.push('');
        }
      }

      // 3. Dead code check
      const deadCode = safe(() => getDeadCodeV2(store, { threshold: 0.5, limit: 10 }), { dead_symbols: [], file_pattern: null, total_exports: 0, total_dead: 0, threshold: 0.5 });
      if (deadCode.dead_symbols && deadCode.dead_symbols.length > 0) {
        sections.push(`## Dead Code Candidates (${deadCode.dead_symbols.length})\n`);
        for (const d of deadCode.dead_symbols.slice(0, 5)) {
          sections.push(`- ${d.name} in ${d.file} (confidence: ${d.confidence})`);
        }
        sections.push('');
      }

      // 4. Hotspots
      const hotspots = safe(() => getHotspots(store, projectRoot, { limit: 5 }), []);
      if (hotspots.length > 0) {
        sections.push('## Risk Hotspots (high complexity + churn)\n');
        for (const h of hotspots) {
          sections.push(`- ${h.file}: complexity=${h.max_cyclomatic}, commits=${h.commits}, score=${h.score.toFixed(2)}`);
        }
        sections.push('');
      }

      const report = sections.join('\n');

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `Review the following changes:\n\n${report}\n\nProvide a thorough code review with risk assessment, suggested tests, and architecture concerns.` },
        }],
      };
    },
  );

  // --- 2. Onboard Prompt ---
  server.prompt(
    'onboard',
    'New developer orientation: project map, architecture, key modules, entry points',
    {},
    async () => {
      const sections: string[] = [];

      // Project map
      const projectCtx = buildProjectContext(projectRoot);
      const map = getProjectMap(store, registry, false, projectCtx);
      sections.push('# Project Onboarding\n');
      sections.push('## Project Map\n');
      sections.push('```json');
      sections.push(JSON.stringify(map, null, 2));
      sections.push('```\n');

      // Architecture health
      const health = safe(() => getRepoHealth(store), null);
      sections.push('## Architecture Health\n');
      sections.push(`- Files in graph: ${health?.summary?.files_in_graph ?? 'N/A'}`);
      sections.push(`- Dependency cycles: ${health?.cycles?.length ?? 0}`);
      sections.push('');

      // Top important files
      sections.push('## Key Entry Points\n');
      const context = safe(() => getFeatureContext(store, projectRoot, 'main entry point application startup', 4000), { symbols: [] } as any);
      if (context.symbols) {
        for (const s of context.symbols.slice(0, 10)) {
          sections.push(`- **${s.name}** (${s.kind}) in ${s.file}:${s.line}`);
        }
      }
      sections.push('');

      const report = sections.join('\n');
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `${report}\n\nExplain this project's architecture, key modules, and how to get started as a new developer. Highlight the most important files to read first.` },
        }],
      };
    },
  );

  // --- 3. Debug Prompt ---
  server.prompt(
    'debug',
    'Debug workflow: trace execution path, find related code, identify failure points',
    {
      description: z.string().describe('Description of the bug or failing behavior'),
      endpoint: z.string().optional().describe('API endpoint or route (if applicable)'),
    },
    async ({ description, endpoint }) => {
      const sections: string[] = [];
      sections.push(`# Debug: ${description}\n`);

      // Feature context for the bug description
      const context = safe(() => getFeatureContext(store, projectRoot, description, 6000), { symbols: [] } as any);
      if (context.symbols && context.symbols.length > 0) {
        sections.push('## Relevant Code\n');
        for (const s of context.symbols.slice(0, 10)) {
          sections.push(`- **${s.name}** (${s.kind}) in ${s.file}:${s.line}`);
        }
        sections.push('');

        // Call graph for the top symbol
        if (context.symbols[0]) {
          const cg = getCallGraph(store, { symbolId: context.symbols[0].symbol_id }, 2);
          if (cg.isOk()) {
            sections.push('## Call Graph (top symbol)\n');
            sections.push('```json');
            sections.push(JSON.stringify(cg.value, null, 2).slice(0, 2000));
            sections.push('```\n');
          }
        }
      }

      if (endpoint) {
        sections.push(`## Endpoint: ${endpoint}\n`);
        sections.push('Use `get_request_flow` to trace the full request lifecycle.\n');
      }

      const report = sections.join('\n');
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `${report}\n\nAnalyze this bug. Identify the most likely failure point, suggest debugging steps, and recommend a fix.` },
        }],
      };
    },
  );

  // --- 4. Architecture Prompt ---
  server.prompt(
    'architecture',
    'Architecture health check: coupling, cycles, tech debt, hotspots, prediction',
    {},
    async () => {
      const sections: string[] = [];
      sections.push('# Architecture Health Check\n');

      // Coupling
      const coupling = safe(() => getCouplingMetrics(store), []);
      const unstable = coupling.filter((c: any) => c.assessment === 'unstable');
      sections.push(`## Coupling (${coupling.length} files)\n`);
      sections.push(`- Unstable: ${unstable.length}`);
      sections.push(`- Stable: ${coupling.filter((c: any) => c.assessment === 'stable').length}`);
      sections.push('');

      // Cycles
      const cycles = safe(() => getDependencyCycles(store), []);
      sections.push(`## Dependency Cycles: ${cycles.length}\n`);
      for (const c of cycles.slice(0, 5)) {
        sections.push(`- ${c.files.join(' → ')}`);
      }
      sections.push('');

      // Tech debt
      const debt = safe(() => getTechDebt(store, projectRoot, {
        moduleDepth: config.predictive?.module_depth,
        sinceDays: config.predictive?.git_since_days,
        weights: config.predictive?.weights?.tech_debt,
      }), null);
      if (debt && debt.isOk()) {
        sections.push('## Tech Debt\n');
        sections.push('```json');
        sections.push(JSON.stringify(debt.value, null, 2).slice(0, 3000));
        sections.push('```\n');
      }

      // Hotspots
      const hotspots = safe(() => getHotspots(store, projectRoot, { limit: 10 }), []);
      if (hotspots.length > 0) {
        sections.push('## Risk Hotspots\n');
        for (const h of hotspots.slice(0, 10)) {
          sections.push(`- ${h.file}: score=${h.score.toFixed(2)}`);
        }
        sections.push('');
      }

      // Bug prediction
      const bugs = safe(() => predictBugs(store, projectRoot, { limit: 10 }), null);
      if (bugs && bugs.isOk()) {
        sections.push('## Bug Prediction (top 10)\n');
        sections.push('```json');
        sections.push(JSON.stringify(bugs.value, null, 2).slice(0, 2000));
        sections.push('```\n');
      }

      const report = sections.join('\n');
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `${report}\n\nAnalyze this project's architecture health. Identify the most critical issues and provide actionable recommendations.` },
        }],
      };
    },
  );

  // --- 5. Pre-Merge Prompt ---
  server.prompt(
    'pre-merge',
    'Pre-merge safety checklist: blast radius, dead code, rename safety, test gaps',
    {
      branch: z.string().describe('Branch to check before merging'),
      base: z.string().optional().describe('Base branch (default: main)'),
    },
    async ({ branch, base }) => {
      const baseRef = base ?? 'main';
      const sections: string[] = [];
      sections.push(`# Pre-Merge Checklist: ${branch} → ${baseRef}\n`);

      // Changed files
      let changedFiles: string[] = [];
      try {
        const { execFileSync } = await import('node:child_process');
        const diff = execFileSync('git', ['diff', '--name-only', `${baseRef}...${branch}`], {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        changedFiles = diff ? diff.split('\n').filter(Boolean) : [];
      } catch {
        sections.push('> Could not determine changed files.\n');
      }

      sections.push(`## Changed Files: ${changedFiles.length}\n`);

      // Blast radius for changed files (batched, limit 5)
      const riskFiles: string[] = [];
      for (const f of changedFiles.slice(0, 5)) {
        const impact = getChangeImpact(store, { filePath: f }, 2, 100);
        if (impact.isOk()) {
          const depCount = Array.isArray(impact.value.dependents) ? impact.value.dependents.length : 0;
          if (depCount > 3) {
            riskFiles.push(`- ⚠ **${f}**: ${depCount} dependents`);
          }
        }
      }
      if (riskFiles.length > 0) {
        sections.push('## High Blast Radius\n');
        sections.push(...riskFiles);
        sections.push('');
      }

      // Dead code
      const dead = safe(() => getDeadCodeV2(store, { threshold: 0.6, limit: 10 }), { dead_symbols: [], file_pattern: null, total_exports: 0, total_dead: 0, threshold: 0.6 });
      if (dead.dead_symbols && dead.dead_symbols.length > 0) {
        sections.push(`## Potential Dead Code: ${dead.dead_symbols.length}\n`);
        for (const d of dead.dead_symbols.slice(0, 5)) {
          sections.push(`- ${d.name} (${d.file})`);
        }
        sections.push('');
      }

      sections.push('## Checklist\n');
      sections.push('- [ ] All changed files have corresponding tests');
      sections.push('- [ ] No high-risk files without reviewer approval');
      sections.push('- [ ] No new circular dependencies introduced');
      sections.push('- [ ] Dead code cleaned up');
      sections.push('');

      const report = sections.join('\n');
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `${report}\n\nReview this pre-merge checklist. Flag any risks and recommend whether it's safe to merge.` },
        }],
      };
    },
  );
}
