/**
 * Behavioral tests for src/cli/check.ts — `trace-mcp check`.
 *
 * `evaluateQualityGates`/`formatGateReport` (../tools/quality/quality-gates.js)
 * already have dedicated coverage in
 * tests/tools/behavioural/check-quality-gates.behavioural.test.ts — this
 * file exercises check.ts's own responsibility instead: config resolution
 * (project config vs. --config file vs. defaults), --fail-on override,
 * --index re-indexing, --format json/text, and exit codes. Everything
 * below the CLI layer (config loading, DB, pipeline, quality-gates
 * evaluation) is mocked.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbInstance = { close: vi.fn() };
const storeInstance = {};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn(actual.readFileSync) },
    readFileSync: vi.fn(actual.readFileSync),
  };
});

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

vi.mock('../../src/indexer/pipeline.js', () => ({
  IndexingPipeline: vi.fn(function IndexingPipeline() {
    return { indexAll: vi.fn(async () => {}) };
  }),
}));

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/plugin-api/registry.js', () => ({
  PluginRegistry: { createWithDefaults: vi.fn(() => ({})) },
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

vi.mock('../../src/registry.js', () => ({
  getProject: vi.fn(() => null),
}));

vi.mock('../../src/tools/quality/quality-gates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/quality/quality-gates.js')>();
  return {
    ...actual,
    evaluateQualityGates: vi.fn(),
    formatGateReport: vi.fn(() => 'formatted report\n'),
  };
});

const { checkCommand } = await import('../../src/cli/check.js');
const { loadConfig } = await import('../../src/config.js');
const { IndexingPipeline } = await import('../../src/indexer/pipeline.js');
const { evaluateQualityGates, formatGateReport } = await import(
  '../../src/tools/quality/quality-gates.js'
);

const mockLoadConfig = vi.mocked(loadConfig);
const mockIndexingPipeline = vi.mocked(IndexingPipeline);
const mockEvaluateQualityGates = vi.mocked(evaluateQualityGates);
const mockFormatGateReport = vi.mocked(formatGateReport);
const mockReadFileSync = vi.mocked(fs.readFileSync);

async function run(args: string[]): Promise<void> {
  await checkCommand.parseAsync(['node', 'trace-mcp-check', ...args]);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function passingReport(overrides: Partial<{ result: 'PASS' | 'FAIL' }> = {}) {
  return {
    summary: { result: overrides.result ?? 'PASS' },
    checks: [],
  } as unknown as ReturnType<typeof evaluateQualityGates>;
}

/** Thrown by the mocked process.exit() so control never falls through, matching real behavior. */
class ProcessExitSignal extends Error {
  code?: number;
  constructor(code?: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockResolvedValue({
    isOk: () => true,
    isErr: () => false,
    value: {
      root: '/proj/current',
      include: ['**/*'],
      exclude: [],
      db: { path: '' },
      plugins: [],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
  } as any);
  mockEvaluateQualityGates.mockReturnValue(passingReport());
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Real process.exit() never returns control to the caller. Mocking it as a
  // no-op (rather than throwing) would let check.ts's `if (opts.config)`
  // branch fall through past `process.exit(2)` on invalid --config JSON and
  // crash later on `gatesConfig.enabled` (missing `return` after the exit
  // call at src/cli/check.ts:69) — see the "invalid --config" tests below.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code);
    // biome-ignore lint/suspicious/noExplicitAny: matches process.exit's `never` return type
  }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('check — config resolution', () => {
  it('falls back to a permissive default config when loadConfig fails', async () => {
    mockLoadConfig.mockResolvedValue({
      isOk: () => false,
      isErr: () => true,
      error: new Error('no config file'),
      // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
    } as any);

    await run([]);

    expect(mockEvaluateQualityGates).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  it('uses default gate thresholds when the project config has no quality_gates section', async () => {
    await run([]);

    // biome-ignore lint/suspicious/noExplicitAny: reaching into loosely-typed gates config
    const gatesConfig = mockEvaluateQualityGates.mock.calls[0][2] as any;
    expect(gatesConfig.enabled).toBe(true);
    expect(gatesConfig.fail_on).toBe('error');
    expect(gatesConfig.rules.max_cyclomatic_complexity).toEqual({
      threshold: 30,
      severity: 'warning',
    });
  });

  it('loads gate config from an explicit --config file', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        quality_gates: {
          enabled: true,
          fail_on: 'error',
          rules: { max_cyclomatic_complexity: { threshold: 10, severity: 'warning' } },
        },
      }),
    );

    await run(['--config', '/tmp/gates.json']);

    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/gates.json', 'utf-8');
    expect(mockEvaluateQualityGates).toHaveBeenCalled();
  });

  it('exits 2 when --config points at invalid JSON', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    await expect(run(['--config', '/tmp/missing.json'])).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('exits 2 when --config JSON fails schema validation', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ quality_gates: { fail_on: 'not-a-valid-level' } }),
    );

    // BUG (src/cli/check.ts:69): the `process.exit(2)` inside the schema-
    // validation branch is not followed by `return`, so with a process.exit
    // that actually halts control flow (as real process.exit does — and as
    // this test's mock faithfully reproduces via throwing) execution never
    // reaches `gatesConfig = parsed.data` on the next line. Asserting the
    // throw here locks in the intended "exit 2" contract; if this test ever
    // starts failing because check.ts changed to swallow the exit and fall
    // through to `gatesConfig.enabled`, that's the latent crash resurfacing.
    await expect(run(['--config', '/tmp/bad-gates.json'])).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorSpy.mock.calls.join(' ')).toMatch(/Invalid quality gates config/);
  });
});

describe('check — --fail-on override', () => {
  it('overrides fail_on from the CLI flag', async () => {
    await run(['--fail-on', 'warning']);

    // biome-ignore lint/suspicious/noExplicitAny: reaching into loosely-typed gates config
    const gatesConfig = mockEvaluateQualityGates.mock.calls[0][2] as any;
    expect(gatesConfig.fail_on).toBe('warning');
  });
});

describe('check — --index', () => {
  it('runs the indexing pipeline before checking when --index is passed', async () => {
    await run(['--index']);

    expect(mockIndexingPipeline).toHaveBeenCalled();
  });

  it('does not index by default', async () => {
    await run([]);

    expect(mockIndexingPipeline).not.toHaveBeenCalled();
  });
});

describe('check — output format', () => {
  it('prints the human-readable report by default', async () => {
    await run([]);

    expect(mockFormatGateReport).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith('formatted report\n');
  });

  it('prints raw JSON with --format json', async () => {
    mockEvaluateQualityGates.mockReturnValue(passingReport());

    await run(['--format', 'json']);

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(() => JSON.parse(written)).not.toThrow();
  });
});

describe('check — exit codes', () => {
  it('exits 1 when the gate report result is FAIL', async () => {
    mockEvaluateQualityGates.mockReturnValue(passingReport({ result: 'FAIL' }));

    await expect(run([])).rejects.toThrow(ProcessExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not exit non-zero when the gate report result is PASS', async () => {
    mockEvaluateQualityGates.mockReturnValue(passingReport({ result: 'PASS' }));

    await run([]);

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('closes the database in all cases', async () => {
    await run([]);
    expect(dbInstance.close).toHaveBeenCalled();
  });
});
