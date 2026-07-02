/**
 * Behavioral tests for src/cli/consent.ts — `trace-mcp consent grant|revoke|list`.
 *
 * Drives the real `consentCommand` (a commander.js Command with subcommands)
 * through `.parseAsync`, with the underlying `../ai/consent.js` persistence
 * layer fully mocked — no real ~/.trace-mcp/consent.json is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ai/consent.js', () => ({
  REMOTE_PROVIDERS: ['openai', 'anthropic', 'voyage'],
  grantConsent: vi.fn(),
  revokeConsent: vi.fn(),
  listConsent: vi.fn(),
}));

const { consentCommand } = await import('../../src/cli/consent.js');
const { grantConsent, revokeConsent, listConsent } = await import('../../src/ai/consent.js');

const mockGrantConsent = vi.mocked(grantConsent);
const mockRevokeConsent = vi.mocked(revokeConsent);
const mockListConsent = vi.mocked(listConsent);

async function run(args: string[]): Promise<void> {
  await consentCommand.parseAsync(['node', 'trace-mcp-consent', ...args]);
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

describe('consent grant', () => {
  it('grants consent for a known provider and prints the timestamp', async () => {
    mockGrantConsent.mockReturnValue({ granted_at: '2026-07-02T00:00:00.000Z', granted_by: 'cli' });

    await run(['grant', 'openai']);

    expect(mockGrantConsent).toHaveBeenCalledWith('openai');
    expect(printed(stdoutSpy)).toContain('Granted consent for openai');
    expect(printed(stdoutSpy)).toContain('2026-07-02T00:00:00.000Z');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('lowercases the provider name before granting', async () => {
    mockGrantConsent.mockReturnValue({ granted_at: 'x', granted_by: 'cli' });

    await run(['grant', 'OpenAI']);

    expect(mockGrantConsent).toHaveBeenCalledWith('openai');
  });

  it('warns (but still grants) for an unrecognized provider', async () => {
    mockGrantConsent.mockReturnValue({ granted_at: 'x', granted_by: 'cli' });

    await run(['grant', 'totally-unknown-llm']);

    expect(printed(stderrSpy)).toMatch(/not in the known-providers list/);
    expect(mockGrantConsent).toHaveBeenCalledWith('totally-unknown-llm');
    expect(printed(stdoutSpy)).toContain('Granted consent for totally-unknown-llm');
  });
});

describe('consent revoke', () => {
  it('revokes an existing consent record', async () => {
    mockRevokeConsent.mockReturnValue(true);

    await run(['revoke', 'openai']);

    expect(mockRevokeConsent).toHaveBeenCalledWith('openai');
    expect(printed(stdoutSpy)).toContain('Revoked consent for openai');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 and reports when there is no record to revoke', async () => {
    mockRevokeConsent.mockReturnValue(false);

    await run(['revoke', 'nonexistent']);

    expect(printed(stderrSpy)).toContain('No consent record for nonexistent');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lowercases the provider name before revoking', async () => {
    mockRevokeConsent.mockReturnValue(true);

    await run(['revoke', 'OpenAI']);

    expect(mockRevokeConsent).toHaveBeenCalledWith('openai');
  });
});

describe('consent list', () => {
  it('prints a friendly message when no consent records exist', async () => {
    mockListConsent.mockReturnValue({});

    await run(['list']);

    expect(printed(stdoutSpy)).toContain('No consent records yet');
  });

  it('lists granted providers sorted alphabetically, human-readable', async () => {
    mockListConsent.mockReturnValue({
      voyage: { granted_at: '2026-01-01T00:00:00.000Z', granted_by: 'cli' },
      anthropic: { granted_at: '2026-02-01T00:00:00.000Z', granted_by: 'cli' },
    });

    await run(['list']);

    const out = printed(stdoutSpy);
    const anthropicIdx = out.indexOf('anthropic');
    const voyageIdx = out.indexOf('voyage');
    expect(anthropicIdx).toBeGreaterThanOrEqual(0);
    expect(voyageIdx).toBeGreaterThan(anthropicIdx);
  });

  it('emits raw JSON with --json', async () => {
    const list = { openai: { granted_at: '2026-01-01T00:00:00.000Z', granted_by: 'cli' as const } };
    mockListConsent.mockReturnValue(list);

    await run(['list', '--json']);

    expect(printed(stdoutSpy)).toBe(`${JSON.stringify(list, null, 2)}\n`);
  });
});
