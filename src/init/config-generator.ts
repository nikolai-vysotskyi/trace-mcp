/**
 * Generate .trace-mcp.json from detection results.
 * Merges framework presets, deduplicates, applies base excludes.
 */

import { TraceMcpConfigSchema, type TraceMcpConfig } from '../config.js';
import type { DetectionResult } from './types.js';
import { FRAMEWORK_PRESETS, LANGUAGE_PRESETS, BASE_EXCLUDE } from './presets.js';

export function generateConfig(detection: DetectionResult): TraceMcpConfig {
  const include = new Set<string>();
  const exclude = new Set<string>(BASE_EXCLUDE);

  // Merge framework presets
  for (const fw of detection.frameworks) {
    const preset = FRAMEWORK_PRESETS[fw.name];
    if (preset) {
      for (const p of preset.include) include.add(p);
      for (const p of preset.exclude) exclude.add(p);
    }
  }

  // If no framework presets matched, fall back to language presets
  if (include.size === 0) {
    for (const lang of detection.languages) {
      const preset = LANGUAGE_PRESETS[lang.toLowerCase()];
      if (preset) {
        for (const p of preset.include) include.add(p);
        for (const p of preset.exclude) exclude.add(p);
      }
    }
  }

  // Ultimate fallback: broad patterns
  if (include.size === 0) {
    include.add('src/**/*');
    include.add('lib/**/*');
    include.add('app/**/*');
  }

  const raw = {
    root: '.',
    include: [...include].sort(),
    exclude: [...exclude].sort(),
  };

  // Validate through Zod to guarantee schema compliance
  return TraceMcpConfigSchema.parse(raw);
}
