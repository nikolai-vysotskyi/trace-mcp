import { describe, it, expect } from 'vitest';
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
  it('generates fallback config when no frameworks or languages detected', () => {
    const config = generateConfig(makeDetection());
    // Fallback includes broad patterns
    expect(config.include!.some((p) => p.includes('src/'))).toBe(true);
    expect(config.exclude!.length).toBeGreaterThan(0);
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

  it('always includes base exclude patterns', () => {
    const config = generateConfig(makeDetection());
    expect(config.exclude).toContain('node_modules/**');
  });

  it('returns valid TraceMcpConfig (validated by Zod)', () => {
    const config = generateConfig(makeDetection());
    expect(config.root).toBe('.');
    expect(Array.isArray(config.include)).toBe(true);
    expect(Array.isArray(config.exclude)).toBe(true);
  });
});
