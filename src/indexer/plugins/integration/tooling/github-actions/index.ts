/**
 * GithubActionsPlugin — detects GitHub Actions workflows and extracts
 * jobs, steps, action references, and trigger events from YAML workflows.
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// --- Extraction patterns (YAML-based, regex on raw content) -------------------

// name: "workflow name"
const WORKFLOW_NAME_RE =
  /^name:\s*['"]?([^\n'"]+)['"]?/m;

// on: push / on: [push, pull_request] / on:\n  push:\n  pull_request:
const TRIGGER_RE =
  /^on:\s*(?:\[([^\]]+)\]|(\w+))/m;

// jobs:\n  job-name:
const JOB_RE =
  /^\s{2}(\w[\w-]*):\s*$/gm;

// uses: actions/checkout@v4
const USES_RE =
  /uses:\s*['"]?([^'"\n]+)['"]?/g;

// run: npm test
const RUN_RE =
  /run:\s*[|>]?\s*\n?\s*(.+)/g;

// needs: [job1, job2] or needs: job1
const NEEDS_RE =
  /needs:\s*(?:\[([^\]]+)\]|(\w[\w-]*))/g;

// --- Helpers -------------------------------------------------------------------

export interface GhaWorkflow {
  name?: string;
  triggers: string[];
  jobs: string[];
  actions: string[];
}

export function extractGhaWorkflow(source: string): GhaWorkflow {
  const result: GhaWorkflow = { triggers: [], jobs: [], actions: [] };

  // Name
  const nameMatch = WORKFLOW_NAME_RE.exec(source);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Triggers
  const triggerMatch = TRIGGER_RE.exec(source);
  if (triggerMatch) {
    if (triggerMatch[1]) {
      result.triggers = triggerMatch[1].split(',').map((t) => t.trim());
    } else if (triggerMatch[2]) {
      result.triggers = [triggerMatch[2]];
    }
  }

  // Jobs
  const jobRe = new RegExp(JOB_RE.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = jobRe.exec(source)) !== null) {
    if (!['name', 'on', 'env', 'permissions', 'concurrency', 'defaults'].includes(m[1])) {
      result.jobs.push(m[1]);
    }
  }

  // Actions (uses:)
  const usesRe = new RegExp(USES_RE.source, 'g');
  while ((m = usesRe.exec(source)) !== null) {
    const action = m[1].trim();
    if (!result.actions.includes(action)) result.actions.push(action);
  }

  return result;
}

// --- Plugin --------------------------------------------------------------------

export class GithubActionsPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'github-actions',
    version: '1.0.0',
    priority: 35,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return ctx.configFiles.some((f) =>
      f.startsWith('.github/workflows/') && (f.endsWith('.yml') || f.endsWith('.yaml')),
    );
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'gha_job', category: 'ci', description: 'GitHub Actions job definition' },
        { name: 'gha_uses', category: 'ci', description: 'GitHub Actions action reference' },
        { name: 'gha_needs', category: 'ci', description: 'GitHub Actions job dependency' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    // Only process YAML files under .github/workflows
    if (language !== 'yaml' || !filePath.includes('.github/workflows')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const workflow = extractGhaWorkflow(source);

    if (workflow.jobs.length > 0 || workflow.triggers.length > 0) {
      result.frameworkRole = 'gha_workflow';

      for (const job of workflow.jobs) {
        result.routes!.push({
          method: 'JOB',
          uri: job,
        });
      }
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
