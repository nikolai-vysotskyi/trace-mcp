import { describe, expect, it } from 'vitest';

describe('detectProject', () => {
  it('detects languages and frameworks from a real project root', async () => {
    const { detectProject } = await import('../../src/init/detector.js');
    const result = detectProject(process.cwd());

    expect(result.projectRoot).toBe(process.cwd());
    // Language names may be capitalized
    expect(result.languages.some((l) => l.toLowerCase() === 'typescript')).toBe(true);
    expect(result.packageManagers.length).toBeGreaterThan(0);
    expect(result.packageManagers.some((pm) => pm.type === 'npm')).toBe(true);
  });

  it('detects frameworks from package.json', async () => {
    const { detectProject } = await import('../../src/init/detector.js');
    const result = detectProject(process.cwd());
    expect(result.frameworks.length).toBeGreaterThan(0);
  });

  it('returns empty arrays for nonexistent directory', async () => {
    const { detectProject } = await import('../../src/init/detector.js');
    const result = detectProject('/tmp/nonexistent-test-dir-12345');
    expect(result.languages).toEqual([]);
    expect(result.frameworks).toEqual([]);
    expect(result.packageManagers).toEqual([]);
  });
});

describe('detectMcpClients', () => {
  it('returns array of detected clients', async () => {
    const { detectMcpClients } = await import('../../src/init/detector.js');
    const clients = detectMcpClients(process.cwd());
    expect(Array.isArray(clients)).toBe(true);
  });
});

describe('detectGuardHook', () => {
  it('returns guard hook status', async () => {
    const { detectGuardHook } = await import('../../src/init/detector.js');
    const result = detectGuardHook();
    expect(result).toHaveProperty('hasGuardHook');
  });
});
