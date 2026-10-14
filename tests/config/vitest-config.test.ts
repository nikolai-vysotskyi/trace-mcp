import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

describe('root vitest config', () => {
  it('excludes separate packages and plugin integrations from root test discovery', () => {
    const exclude = config.test?.exclude;
    expect(exclude).toContain('packages/app/**');
    expect(exclude).toContain('integrations/**');
  });

  it('caps workers at 2 when running on Windows in CI (TRA-2427)', () => {
    const isWinCI = Boolean(process.env.CI && process.platform === 'win32');
    if (isWinCI) {
      expect(config.test?.maxWorkers).toBe(2);
    } else {
      expect(config.test?.maxWorkers).toBeUndefined();
    }
  });
});
