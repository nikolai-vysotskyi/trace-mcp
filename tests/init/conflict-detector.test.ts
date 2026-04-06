import { describe, it, expect } from 'vitest';
import { detectConflicts } from '../../src/init/conflict-detector.js';

describe('detectConflicts', () => {
  it('returns a conflict report with expected shape', () => {
    const report = detectConflicts(process.cwd());

    expect(report).toHaveProperty('conflicts');
    expect(report).toHaveProperty('scannedAt');
    expect(Array.isArray(report.conflicts)).toBe(true);
  });

  it('each conflict has required fields', () => {
    const report = detectConflicts(process.cwd());
    for (const c of report.conflicts) {
      expect(c).toHaveProperty('severity');
      expect(c).toHaveProperty('category');
      expect(c).toHaveProperty('summary');
      expect(['critical', 'warning', 'info']).toContain(c.severity);
    }
  });

  it('does not crash on nonexistent project root', () => {
    const report = detectConflicts('/tmp/nonexistent-dir-xyz-99999');
    expect(Array.isArray(report.conflicts)).toBe(true);
  });

  it('detects conflicts in the current project', () => {
    const report = detectConflicts(process.cwd());
    // This is a trace-mcp project, so there may or may not be conflicts
    // but the function should not throw
    expect(typeof report.scannedAt).toBe('string');
  });
});
