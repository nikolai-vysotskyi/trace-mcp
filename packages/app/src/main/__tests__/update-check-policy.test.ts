/**
 * Retry policy for the bundle self-update (TRA-2104): transient failures get
 * retried by the poll cadence, settled ones must not be mistaken for them,
 * and a tray with no open window still checks on a safety-net interval.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_UPDATE_CHECK_AFTER_MS,
  BACKGROUND_UPDATE_CHECK_TICK_MS,
  isTransientUpdateError,
  shouldBackgroundRecheck,
} from '../update-check-policy';

describe('isTransientUpdateError', () => {
  it.each([
    // The TRA-2104 incident: the release tag is `latest` minutes before the
    // feed finishes uploading, so the updater polls a 404.
    'HttpError: 404 Http method GET failed on https://github.com/nikolai-vysotskyi/trace-mcp/releases/download/v3.34.4/latest-mac.yml',
    'Cannot find latest-mac.yml in the latest release artifacts',
    'net::ERR_HTTP2_SERVER_REFUSED_STREAM',
    'net::ERR_HTTP2_PROTOCOL_ERROR',
    'timeout',
    'offline',
    'request to https://github.com failed, reason: socket hang up',
    'HttpError: 503 Service Unavailable',
    'getaddrinfo ENOTFOUND github.com',
    'request failed, reason: read ETIMEDOUT',
  ])('treats %j as transient', (message) => {
    expect(isTransientUpdateError(message)).toBe(true);
  });

  it.each([
    // Settled states: retrying these on a timer burns requests and log lines.
    'Code signature verification failed',
    'latest-mac.yml has invalid signature',
    '401 Unauthorized — bad credentials',
    '',
    'update not available',
  ])('treats %j as settled', (message) => {
    expect(isTransientUpdateError(message)).toBe(false);
  });
});

describe('shouldBackgroundRecheck', () => {
  it('is due when nothing ever checked', () => {
    expect(shouldBackgroundRecheck(undefined, 1_000_000)).toBe(true);
  });

  it('stays idle while the renderer poll is checking', () => {
    const now = 1_000_000;
    // Renderer checks every 10 minutes — far inside the safety-net window.
    expect(shouldBackgroundRecheck(now - 10 * 60 * 1000, now)).toBe(false);
  });

  it('fires once checks go quiet past the interval', () => {
    const now = 1_000_000;
    expect(shouldBackgroundRecheck(now - BACKGROUND_UPDATE_CHECK_AFTER_MS, now)).toBe(true);
    expect(shouldBackgroundRecheck(now - BACKGROUND_UPDATE_CHECK_AFTER_MS - 1, now)).toBe(true);
  });

  it('keeps the safety net well behind the renderer cadence', () => {
    // Renderer: 10 min (renderer/update-check.ts). Net tick: 15 min, due
    // after 30 min of quiet — idle while any window is open.
    expect(BACKGROUND_UPDATE_CHECK_TICK_MS).toBeLessThan(BACKGROUND_UPDATE_CHECK_AFTER_MS);
    expect(BACKGROUND_UPDATE_CHECK_AFTER_MS).toBeGreaterThan(10 * 60 * 1000);
  });
});
