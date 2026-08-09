import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');

import fs from 'node:fs';
import { sendUsagePing } from '../usage-ping.js';

function makeFetchSpy(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CONFIGURED_ENV = {
  TRACE_MCP_GA_MEASUREMENT_ID: 'G-TEST123',
  TRACE_MCP_GA_API_SECRET: 'secret-abc',
} as NodeJS.ProcessEnv;

describe('sendUsagePing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
  });

  it('no-ops when TRACE_MCP_TELEMETRY=off, even if GA credentials are configured', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({
      version: '1.2.3',
      env: { ...CONFIGURED_ENV, TRACE_MCP_TELEMETRY: 'off' },
      fetchImpl,
    });
    expect(calls).toHaveLength(0);
  });

  it('no-ops when GA credentials are not configured', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: {}, fetchImpl });
    expect(calls).toHaveLength(0);
  });

  it('sends one event with version/platform/node_major and an anonymous client_id on first run', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('measurement_id=G-TEST123');
    expect(calls[0]!.url).toContain('api_secret=secret-abc');
    const body = calls[0]!.body as {
      client_id: string;
      events: Array<{ name: string; params: Record<string, unknown> }>;
    };
    expect(typeof body.client_id).toBe('string');
    expect(body.client_id.length).toBeGreaterThan(0);
    expect(body.events[0]?.name).toBe('app_open');
    expect(body.events[0]?.params.version).toBe('1.2.3');
    expect(body.events[0]?.params.platform).toBe(process.platform);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not send a second ping the same UTC day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ installId: 'fixed-id', lastPingDate: today }),
    );
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });
    expect(calls).toHaveLength(0);
  });

  it('reuses the persisted install id across runs instead of generating a new one', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ installId: 'fixed-id', lastPingDate: '2000-01-01' }),
    );
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });
    const body = calls[0]!.body as { client_id: string };
    expect(body.client_id).toBe('fixed-id');
  });

  it('swallows fetch failures without throwing and does not update lastPingDate', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl }),
    ).resolves.toBeUndefined();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
