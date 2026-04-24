/**
 * [internal record] tool-routing block wrapper.
 *
 * All content + marker + competitor-cleanup logic lives in `md-block.ts` so
 * [internal record] and AGENTS.md stay in sync. This module is just a path picker.
 */

import path from 'node:path';
import type { InitStepResult } from './types.js';
import { upsertTraceMcpBlock } from './md-block.js';

export function updateClaudeMd(
  projectRoot: string,
  opts: { dryRun?: boolean; scope?: 'global' | 'project' },
): InitStepResult {
  const filePath = opts.scope === 'global'
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', '[internal record]')
    : path.join(projectRoot, '[internal record]');

  return upsertTraceMcpBlock(filePath, { dryRun: opts.dryRun });
}
