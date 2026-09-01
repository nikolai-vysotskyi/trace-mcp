import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');
vi.mock('../top-model.js', () => ({ topModelLastDay: () => 'claude-opus-4-6' }));

import fs from 'node:fs';
import { recordUsagePingClient, sendUsagePing } from '../usage-ping.js';

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

  it('carries session_id and engagement_time_msec so GA4 counts the install as an active user', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({
      version: '1.2.3',
      env: CONFIGURED_ENV,
      fetchImpl,
      nowMs: 1_700_000_000_000,
    });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.session_id).toBe('1700000000');
    expect(params.engagement_time_msec).toBe(1);
  });

  it('reports the MCP client name recorded by a previous session, and the model it drove', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ installId: 'fixed-id', lastPingDate: '2000-01-01', client: 'claude-code' }),
    );
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.client).toBe('claude-code');
    expect(params.model).toBe('claude-opus-4-6');
  });

  it('sends the country as user_location and never an ip_override', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });
    const body = calls[0]!.body as Record<string, unknown> & {
      user_location?: { country_id: string };
      events: Array<{ params: Record<string, unknown> }>;
    };
    expect(body).not.toHaveProperty('ip_override');
    expect(body.events[0]!.params).not.toHaveProperty('timezone');
    // The test machine has a real zone, so a country resolves; assert the shape.
    if (body.user_location) expect(body.user_location.country_id).toMatch(/^[A-Z]{2}$/);
  });

  it('reports how many repositories are indexed, without their paths', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({
      version: '1.2.3',
      env: CONFIGURED_ENV,
      fetchImpl,
      loadSavings: () =>
        ({
          total_tokens_saved: 10,
          total_calls: 2,
          per_project: { '/home/me/secret-repo': {}, '/work/other': {} },
        }) as never,
    });
    const serialised = JSON.stringify(calls[0]!.body);
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.repos_indexed).toBe(2);
    expect(serialised).not.toContain('secret-repo');
  });

  it('falls back to an unknown client when nothing has connected yet', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.client).toBe('unknown');
  });

  it('reports the active preset and the number of tools it advertised', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({
      version: '1.2.3',
      env: CONFIGURED_ENV,
      fetchImpl,
      preset: 'minimal',
      toolsAdvertised: 28,
    });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.preset).toBe('minimal');
    expect(params.tools_advertised).toBe(28);
  });

  it('keeps a client name recorded while the ping was in flight (TRA-643)', async () => {
    // The ping fires before the handshake, so `initialize` routinely lands
    // mid-fetch. Saving the pre-fetch snapshot used to erase the name that
    // `recordUsagePingClient` had just written — leaving every install whose
    // only session of the day was the one that pinged permanently `unknown`.
    let state = JSON.stringify({ installId: 'fixed-id', lastPingDate: '2000-01-01' });
    vi.mocked(fs.readFileSync).mockImplementation(() => state);
    vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
      state = String(data);
    });
    const fetchImpl = vi.fn(async () => {
      recordUsagePingClient('claude-code', CONFIGURED_ENV);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });

    expect(JSON.parse(state).client).toBe('claude-code');
    expect(JSON.parse(state).lastPingDate).toBe(new Date().toISOString().slice(0, 10));
    expect(JSON.parse(state).installId).toBe('fixed-id');
  });

  it('records the client name for the next ping, and honours the opt-out', () => {
    recordUsagePingClient('cursor', {});
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fs.writeFileSync).mock.calls[0]![1])).client).toBe('cursor');

    vi.mocked(fs.writeFileSync).mockClear();
    recordUsagePingClient('cursor', { TRACE_MCP_TELEMETRY: 'off' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('reports savings as a delta since the previous ping and remembers the new totals', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        installId: 'fixed-id',
        lastPingDate: '2000-01-01',
        lastTokensSaved: 1000,
        lastCalls: 10,
      }),
    );
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({
      version: '1.2.3',
      env: CONFIGURED_ENV,
      fetchImpl,
      loadSavings: () => ({ total_tokens_saved: 2500, total_calls: 40 }) as never,
    });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.tokens_saved).toBe(1500);
    expect(params.calls).toBe(30);
    const written = JSON.parse(String(vi.mocked(fs.writeFileSync).mock.calls[0]![1]));
    expect(written.lastTokensSaved).toBe(2500);
    expect(written.lastCalls).toBe(40);
  });

  it('sends zeroed counters when there is no savings file and never a negative delta', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({
      version: '1.2.3',
      env: CONFIGURED_ENV,
      fetchImpl,
      loadSavings: () => null,
    });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.tokens_saved).toBe(0);
    expect(params.calls).toBe(0);
  });

  it('marks the very first run as a new install', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.install_type).toBe('new');
    expect(params.previous_version).toBe('none');
    expect(JSON.parse(String(vi.mocked(fs.writeFileSync).mock.calls[0]![1])).lastVersion).toBe(
      '1.2.3',
    );
  });

  it.each([
    ['1.2.3', '2.0.0', 'upgrade'],
    ['2.0.0', '1.9.9', 'downgrade'],
    ['1.2.3', '1.2.3', 'active'],
  ])('reports %s -> %s as %s', async (from, to, expected) => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ installId: 'fixed-id', lastPingDate: '2000-01-01', lastVersion: from }),
    );
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: to, env: CONFIGURED_ENV, fetchImpl });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.install_type).toBe(expected);
    expect(params.previous_version).toBe(from);
  });

  it('reports the machine class without anything identifying it', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: CONFIGURED_ENV, fetchImpl });
    const params = (calls[0]!.body as { events: Array<{ params: Record<string, unknown> }> })
      .events[0]!.params;
    expect(params.arch).toBe(process.arch);
    expect(typeof params.cpu_count).toBe('number');
    expect(typeof params.ram_gb).toBe('number');
    expect(typeof params.os_version).toBe('string');
    const serialised = JSON.stringify(calls[0]!.body);
    expect(serialised).not.toContain(process.env.USER ?? '\u0000never');
  });

  it('stays silent in CI, where every job is a fresh install id', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    await sendUsagePing({ version: '1.2.3', env: { ...CONFIGURED_ENV, CI: 'true' }, fetchImpl });
    expect(calls).toHaveLength(0);
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
