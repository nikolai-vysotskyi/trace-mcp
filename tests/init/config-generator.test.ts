import { describe, expect, it } from 'vitest';
import { generateConfig } from '../../src/init/config-generator.js';
import type { DetectionResult } from '../../src/init/types.js';

function makeDetection(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    projectRoot: '/test',
    packageManagers: [],
    frameworks: [],
    languages: [],
    mcpClients: [],
    existingConfig: null,
    existingDb: null,
    hasClaudeMd: false,
    claudeMdHasTraceMcpBlock: false,
    hasGuardHook: false,
    guardHookVersion: null,
    ...overrides,
  };
}

describe('generateConfig', () => {
  it('generates a comprehensive fallback config when no frameworks or languages detected', () => {
    const config = generateConfig(makeDetection());
    // Fallback uses the schema defaults, which are global extension globs
    // (TRA-400) — no directory anchoring, so a non-framework or
    // monorepo-container root picks up nested subprojects wherever they live.
    expect(config.include!.every((p) => p.startsWith('**/'))).toBe(true);
    for (const ext of ['ts', 'py', 'go', 'php', 'vhd', 'tf', 'sql', 'css']) {
      expect(
        config.include!.some((p) => p.includes(`,${ext},`) || p.includes(`{${ext},`)),
        `default include does not reach .${ext}`,
      ).toBe(true);
    }
    // And excludes the universal junk (vendor was previously missing).
    expect(config.exclude!.some((p) => p.includes('vendor'))).toBe(true);
    expect(config.exclude!.some((p) => p.includes('node_modules'))).toBe(true);
  });

  it('applies framework preset for Laravel', () => {
    const config = generateConfig(
      makeDetection({
        frameworks: [{ name: 'laravel', category: 'framework' }],
      }),
    );
    // Laravel preset should include PHP patterns in app/
    expect(config.include!.some((p) => p.includes('app/'))).toBe(true);
    expect(config.include!.some((p) => p.includes('routes/'))).toBe(true);
  });

  it('applies language preset when no frameworks match', () => {
    const config = generateConfig(
      makeDetection({
        languages: ['python'],
      }),
    );
    expect(config.include!.length).toBeGreaterThan(0);
  });

  it('applies framework preset over language fallback', () => {
    const config = generateConfig(
      makeDetection({
        frameworks: [{ name: 'nestjs', category: 'framework' }],
        languages: ['typescript'],
      }),
    );
    // NestJS preset should include src patterns
    expect(config.include!.some((p) => p.includes('src/'))).toBe(true);
  });

  it('merges multiple framework presets', () => {
    const config = generateConfig(
      makeDetection({
        frameworks: [
          { name: 'laravel', category: 'framework' },
          { name: 'react', category: 'view' },
        ],
      }),
    );
    expect(config.include!.length).toBeGreaterThanOrEqual(3);
  });

  it('always excludes node_modules (form-agnostic)', () => {
    // Framework path keeps BASE_EXCLUDE form (`node_modules/**`); the empty-detection
    // fallback now yields schema defaults (`**/node_modules/**`). Either is fine.
    const fw = generateConfig(
      makeDetection({ frameworks: [{ name: 'laravel', category: 'framework' }] }),
    );
    expect(fw.exclude!.some((p) => p.includes('node_modules'))).toBe(true);
    expect(fw.exclude!.some((p) => p.includes('vendor'))).toBe(true);
  });

  it('returns valid TraceMcpConfig (validated by Zod)', () => {
    const config = generateConfig(makeDetection());
    expect(config.root).toBe('.');
    expect(Array.isArray(config.include)).toBe(true);
    expect(Array.isArray(config.exclude)).toBe(true);
  });
});
