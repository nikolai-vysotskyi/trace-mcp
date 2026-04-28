/**
 * AGENTS.md tool-routing block for Hermes and other agents that follow the
 * [agents.md](https://agents.md/) convention.
 *
 * Hermes loads AGENTS.md ONLY from the current working directory (see
 * `prompt_builder._load_agents_md`). A user-level `~/.hermes/AGENTS.md`
 * is NOT consulted by Hermes — that file wouldn't do anything there, so
 * `scope: 'global'` writes to `~/.claude/`-equivalent only if the caller
 * insists; the default `scope: 'project'` writes next to the current project.
 */
import path from 'node:path';
import { upsertTraceMcpBlock } from './md-block.js';
import type { InitStepResult } from './types.js';

export function updateAgentsMd(
  projectRoot: string,
  opts: { dryRun?: boolean; scope?: 'project' } = {},
): InitStepResult {
  const _scope = opts.scope ?? 'project';
  // Only project scope is meaningful for AGENTS.md today. The parameter exists
  // to make the API symmetrical with `updateClaudeMd` for future flexibility.
  void _scope;
  const filePath = path.join(projectRoot, 'AGENTS.md');
  return upsertTraceMcpBlock(filePath, { dryRun: opts.dryRun });
}
