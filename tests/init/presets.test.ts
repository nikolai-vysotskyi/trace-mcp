import { describe, expect, it } from 'vitest';
import { BASE_EXCLUDE, FRAMEWORK_PRESETS, LANGUAGE_PRESETS } from '../../src/init/presets.js';

describe('init presets', () => {
  it('BASE_EXCLUDE contains standard ignore patterns', () => {
    expect(BASE_EXCLUDE).toContain('node_modules/**');
  });

  it('FRAMEWORK_PRESETS has entries for major frameworks', () => {
    expect(FRAMEWORK_PRESETS).toHaveProperty('laravel');
    expect(FRAMEWORK_PRESETS).toHaveProperty('nestjs');
    expect(FRAMEWORK_PRESETS).toHaveProperty('django');
    expect(FRAMEWORK_PRESETS).toHaveProperty('rails');
    expect(FRAMEWORK_PRESETS).toHaveProperty('react');
  });

  it('each framework preset has include and exclude arrays', () => {
    for (const [name, preset] of Object.entries(FRAMEWORK_PRESETS)) {
      expect(Array.isArray(preset.include), `${name}.include`).toBe(true);
      expect(Array.isArray(preset.exclude), `${name}.exclude`).toBe(true);
      expect(preset.include.length, `${name}.include should have entries`).toBeGreaterThan(0);
    }
  });

  it('LANGUAGE_PRESETS has entries for major languages', () => {
    expect(LANGUAGE_PRESETS).toHaveProperty('typescript');
    expect(LANGUAGE_PRESETS).toHaveProperty('python');
    expect(LANGUAGE_PRESETS).toHaveProperty('go');
    expect(LANGUAGE_PRESETS).toHaveProperty('rust');
  });

  it('each language preset has include and exclude arrays', () => {
    for (const [name, preset] of Object.entries(LANGUAGE_PRESETS)) {
      expect(Array.isArray(preset.include), `${name}.include`).toBe(true);
      expect(Array.isArray(preset.exclude), `${name}.exclude`).toBe(true);
    }
  });
});
