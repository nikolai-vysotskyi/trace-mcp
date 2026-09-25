/**
 * Benchmark Lab arms (TRA-1951).
 *
 * v1 measures only our own surface, three arms over the same pinned battery:
 *
 *   file-reading — the control. Raw file reads from disk, no index, priced in
 *                  exact tokens. What an agent without trace-mcp has to load.
 *   minimal      — the shipped default preset's tools (search, outlines,
 *                  single-symbol reads, FTS). One call per fixture.
 *   standard     — the wider surface (packed context envelopes, symbol source
 *                  on the top hit, broader decision recall). More context per
 *                  fixture, priced the same way.
 *
 * Competitor servers are v2, not here: their binaries, keys and availability
 * make them unreproducible inside this process. A v2 importer for hand-recorded
 * third-party figures (source + date) belongs in a separate issue.
 */

import { TOOL_PRESETS } from '../tools/project/presets.js';

export type LabArmId = 'file-reading' | 'minimal' | 'standard';

export interface LabArm {
  id: LabArmId;
  /** Short label for tables and the arm picker. */
  label: string;
  /** One sentence the UI prints under the picker. */
  description: string;
  /**
   * MCP tool names this arm may call. Empty for file-reading: the control arm
   * deliberately touches no index tool, only the filesystem.
   */
  tools: string[];
}

function presetTools(name: 'minimal' | 'standard'): string[] {
  const entry = TOOL_PRESETS[name];
  return Array.isArray(entry) ? [...entry] : [];
}

export const LAB_ARMS: LabArm[] = [
  {
    id: 'file-reading',
    label: 'File reading (baseline)',
    description:
      'Raw file reads from disk, no index — what the same questions cost without trace-mcp.',
    tools: [],
  },
  {
    id: 'minimal',
    label: 'minimal preset',
    description: 'The shipped default surface: search, outlines, single-symbol reads.',
    tools: presetTools('minimal'),
  },
  {
    id: 'standard',
    label: 'standard preset',
    description: 'The wider surface: packed context envelopes plus symbol source on the top hit.',
    tools: presetTools('standard'),
  },
];

export function getLabArm(id: string): LabArm | undefined {
  return LAB_ARMS.find((a) => a.id === id);
}

export function isLabArmId(id: string): id is LabArmId {
  return LAB_ARMS.some((a) => a.id === id);
}
