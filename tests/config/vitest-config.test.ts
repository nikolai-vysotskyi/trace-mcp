import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

describe('root vitest config', () => {
  it('excludes separate packages and plugin integrations from root test discovery', () => {
    const exclude = config.test?.exclude;
    expect(exclude).toContain('packages/app/**');
    expect(exclude).toContain('integrations/**');
  });
});
