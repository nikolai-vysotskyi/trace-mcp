/**
 * Behavioral tests for src/cli/scan-security.ts — `trace-mcp scan-security`.
 *
 * scanSecurity itself has dedicated coverage in tests/tools/security-scan.test.ts.
 * This exercises the CLI layer: DB bootstrap, --rules/--scope passthrough,
 * --format json/sarif, and --fail-on exit-code semantics. Everything below
 * the CLI (config loading, DB, scanSecurity) is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbInstance = { close: vi.fn() };
const storeInstance = {};

vi.mock('../../src/config.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/config.js')>()),
  loadConfig: vi.fn(),
}));

vi.mock('../../src/db/schema.js', () => ({
  initializeDatabase: vi.fn(() => dbInstance),
}));

vi.mock('../../src/db/store.js', () => ({
  Store: vi.fn(function Store() {
    return storeInstance;
  }),
}));

vi.mock('../../src/global.js', () => ({
  ensureGlobalDirs: vi.fn(),
  getDbPath: vi.fn(() => '/idx/fallback.db'),
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

vi.mock('../../src/registry.js', () => ({
  getProject: vi.fn(() => null),
}));

vi.mock('../../src/tools/quality/security-scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/quality/security-scan.js')>();
  return {
    ...actual,
    scanSecurity: vi.fn(),
  };
});

const { scanSecurityCommand } = await import('../../src/cli/scan-security.js');
const { loadConfig } = await import('../../src/config.js');
const { scanSecurity } = await import('../../src/tools/quality/security-scan.js');

const mockLoadConfig = vi.mocked(loadConfig);
const mockScanSecurity = vi.mocked(scanSecurity);

async function run(args: string[]): Promise<void> {
  await scanSecurityCommand.parseAsync(['node', 'trace-mcp-scan-security', ...args]);
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

class ProcessExitSignal extends Error {
  code?: number;
  constructor(code?: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function okResult(findings: Array<{ severity: 'critical' | 'high' | 'medium' | 'low' }> = []) {
  return {
    isOk: () => true,
    isErr: () => false,
    value: {
      files_scanned: 1,
      findings: findings.map((f, i) => ({
        rule_id: 'CWE-89',
        rule_name: 'SQL Injection',
        severity: f.severity,
        file: `src/f${i}.ts`,
        line: 1,
        column: 1,
        snippet: 'x',
        fix: 'fix it',
      })),
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockResolvedValue({
    isOk: () => true,
    isErr: () => false,
    value: { root: '/proj/current', include: ['**/*'], exclude: [], db: { path: '' }, plugins: [] },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
  } as any);
  mockScanSecurity.mockReturnValue(okResult());
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code);
    // biome-ignore lint/suspicious/noExplicitAny: matches process.exit's `never` return type
  }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('scan-security — rules/scope passthrough', () => {
  it('defaults to ["all"] when --rules is not passed', async () => {
    await run([]);

    expect(mockScanSecurity).toHaveBeenCalledWith(
      storeInstance,
      '/proj/current',
      expect.objectContaining({ rules: ['all'] }),
    );
  });

  it('splits a comma-separated --rules list', async () => {
    await run(['--rules', 'sql_injection,xss']);

    expect(mockScanSecurity).toHaveBeenCalledWith(
      storeInstance,
      '/proj/current',
      expect.objectContaining({ rules: ['sql_injection', 'xss'] }),
    );
  });

  it('passes --scope through', async () => {
    await run(['--scope', 'src/cli']);

    expect(mockScanSecurity).toHaveBeenCalledWith(
      storeInstance,
      '/proj/current',
      expect.objectContaining({ scope: 'src/cli' }),
    );
  });
});

describe('scan-security — output format', () => {
  it('prints raw JSON by default', async () => {
    await run([]);

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(written);
    expect(parsed.files_scanned).toBe(1);
  });

  it('prints a SARIF log with --format sarif', async () => {
    mockScanSecurity.mockReturnValue(okResult([{ severity: 'high' }]));

    await expect(run(['--format', 'sarif'])).rejects.toThrow(ProcessExitSignal);

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(written);
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0].results).toHaveLength(1);
  });
});

describe('scan-security — --fail-on exit codes', () => {
  it('exits 1 when a finding at/above --fail-on severity exists (default: high)', async () => {
    mockScanSecurity.mockReturnValue(okResult([{ severity: 'high' }]));

    await expect(run([])).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not exit non-zero when all findings are below --fail-on severity', async () => {
    mockScanSecurity.mockReturnValue(okResult([{ severity: 'low' }]));

    await run([]);

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('never exits non-zero with --fail-on none, even with critical findings', async () => {
    mockScanSecurity.mockReturnValue(okResult([{ severity: 'critical' }]));

    await run(['--fail-on', 'none']);

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('closes the database in all cases', async () => {
    await run([]);
    expect(dbInstance.close).toHaveBeenCalled();
  });
});

describe('scan-security — error handling', () => {
  it('exits 2 and prints the formatted error when scanSecurity fails', async () => {
    mockScanSecurity.mockReturnValue({
      isOk: () => false,
      isErr: () => true,
      error: { code: 'VALIDATION_ERROR', message: 'No valid rules specified' },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
    } as any);

    await expect(run([])).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorSpy).toHaveBeenCalled();
  });
});
