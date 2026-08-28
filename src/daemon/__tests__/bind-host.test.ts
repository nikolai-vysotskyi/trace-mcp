import { describe, expect, it } from 'vitest';
import { checkBindHost, isLoopbackHost } from '../bind-host.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'example.com', '128.0.0.1'])(
    'treats %s as remote',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('checkBindHost', () => {
  it('allows the default loopback bind', () => {
    expect(checkBindHost('127.0.0.1', false)).toBeNull();
  });

  it('refuses a non-loopback bind without the opt-in', () => {
    const refusal = checkBindHost('0.0.0.0', false);
    expect(refusal).toContain('0.0.0.0');
    expect(refusal).toContain('--allow-remote');
  });

  it('allows a non-loopback bind with the explicit opt-in', () => {
    expect(checkBindHost('0.0.0.0', true)).toBeNull();
  });
});
