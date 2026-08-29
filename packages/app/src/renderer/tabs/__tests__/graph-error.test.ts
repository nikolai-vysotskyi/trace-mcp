import { describe, expect, it } from 'vitest';

import { userFacingError } from '../graph-error';

describe('userFacingError', () => {
  it('replaces the browser transport rejections with a cause and a next step', () => {
    const raws = [
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
    ];
    for (const raw of raws) {
      expect(userFacingError(new Error(raw))).toBe("Can't reach the trace-mcp daemon.");
    }
  });

  it('falls back to the daemon sentence when there is no message at all', () => {
    expect(userFacingError(null)).toBe("Can't reach the trace-mcp daemon.");
    expect(userFacingError(new Error('  '))).toBe("Can't reach the trace-mcp daemon.");
  });

  it('passes messages the daemon sent through verbatim', () => {
    expect(userFacingError(new Error('Project not found: /x'))).toBe('Project not found: /x');
    expect(userFacingError(new Error('Server error (500)'))).toBe('Server error (500)');
  });
});
