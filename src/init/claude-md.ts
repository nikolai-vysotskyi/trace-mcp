/**
 * CLAUDE.md tool-routing block wrapper.
 *
 * All content + marker + competitor-cleanup logic lives in `md-block.ts` so
 * CLAUDE.md and AGENTS.md stay in sync. This module is just a path picker.
 */

import path from 'node:path';
import type { InitStepResult } from './types.js';
import { upsertTraceMcpBlock } from './md-block.js';

export function updateClaudeMd(
  projectRoot: string,
  opts: { dryRun?: boolean; scope?: 'global' | 'project' },
): InitStepResult {
  const filePath = opts.scope === 'global'
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'CLAUDE.md')
    : path.join(projectRoot, 'CLAUDE.md');

  return upsertTraceMcpBlock(filePath, { dryRun: opts.dryRun });
}
