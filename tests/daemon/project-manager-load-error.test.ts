import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock registry BEFORE importing the SUT — listProjects() drives the
// loadAllRegistered() loop. We deliberately return ONE good-looking entry so
// the loop reaches the addProject() call and we can force a rejection.
//
// The root uses a nonexistent parent dir so the issue-#168 stale-folder
// eviction does NOT prune it before addProject runs — that eviction only
// fires when the parent dir still exists (real deletion vs. unmounted volume).
vi.mock('../../src/registry.js', () => ({
  listProjects: vi.fn(() => [{ root: '/__trace_mcp_nonexistent_parent__/proj-corrupt' }]),
  unregisterProject: vi.fn(),
}));

vi.mock('../../src/progress.js', () => ({
  ProgressState: vi.fn(),
  clearServerPid: vi.fn(),
  writeServerPid: vi.fn(),
}));

vi.mock('../../src/project-setup.js', () => ({
  // listProjects returns /__trace_mcp_nonexistent_parent__/proj-corrupt which is NOT a dangerous root.
  isDangerousProjectRoot: vi.fn(() => null),
  setupProject: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { ProjectManager } from '../../src/daemon/project-manager.js';
import { logger } from '../../src/logger.js';

const mockedErrorLog = vi.mocked(logger.error);

describe('ProjectManager.loadAllRegistered — error logging', () => {
  beforeEach(() => {
    mockedErrorLog.mockClear();
  });

  it("emits the SQLite error's .message field (not just .code) when a project fails to load", async () => {
    const pm = new ProjectManager();

    // Force addProject() to reject with a realistic better-sqlite3 error.
    // The pre-fix log call passed this raw Error under the `error:` key, and
    // pino JSON.stringify'd it — collapsing the payload to {"code":...} and
    // dropping the non-enumerable .message. After the fix, serializeError()
    // explicitly copies .message + .stack + .code so triage is possible.
    const sqliteError = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT',
      codeName: 'SQLITE_CORRUPT_VTAB',
    });
    // biome-ignore lint/suspicious/noExplicitAny: stubbing private method on the SUT
    vi.spyOn(pm as any, 'addProject').mockRejectedValue(sqliteError);

    await pm.loadAllRegistered();

    // Find the failure-log call by message.
    const failureCall = mockedErrorLog.mock.calls.find(
      (call) => call[1] === 'Failed to load registered project',
    );
    expect(failureCall, 'Failed to load registered project log call').toBeDefined();

    const payload = failureCall![0] as Record<string, unknown>;
    expect(payload.projectRoot).toBe('/__trace_mcp_nonexistent_parent__/proj-corrupt');
    // dbPath is included so the operator can run `sqlite3 <path>` for triage.
    expect(typeof payload.dbPath).toBe('string');
    expect((payload.dbPath as string).length).toBeGreaterThan(0);

    // The whole point of the fix: the SQLite error text MUST survive.
    const errorField = payload.error as Record<string, unknown>;
    expect(errorField).toBeDefined();
    expect(errorField.message).toBe('database disk image is malformed');
    expect(errorField.code).toBe('SQLITE_CORRUPT');
    // better-sqlite3 extended result code distinguishes from generic SQLITE_CORRUPT.
    expect(errorField.codeName).toBe('SQLITE_CORRUPT_VTAB');
    // Stack must be present for proper triage of the call chain.
    expect(typeof errorField.stack).toBe('string');
    expect((errorField.stack as string).length).toBeGreaterThan(0);

    // Regression guardrail: the emitted record must round-trip through
    // JSON.stringify with the message intact. The pre-fix payload would lose
    // .message at this step — which is exactly what happened on the user's box.
    const roundTripped = JSON.parse(JSON.stringify(payload));
    expect(roundTripped.error.message).toBe('database disk image is malformed');
    expect(roundTripped.error.code).toBe('SQLITE_CORRUPT');
  });

  it('handles non-Error rejection reasons without crashing', async () => {
    const pm = new ProjectManager();
    // Some upstream paths reject with a plain object (e.g. neverthrow Result.error).
    // biome-ignore lint/suspicious/noExplicitAny: stubbing private method on the SUT
    vi.spyOn(pm as any, 'addProject').mockRejectedValue({
      code: 'SQLITE_ERROR',
      message: 'no such table: symbols',
    });

    await pm.loadAllRegistered();

    const failureCall = mockedErrorLog.mock.calls.find(
      (call) => call[1] === 'Failed to load registered project',
    );
    expect(failureCall).toBeDefined();
    const payload = failureCall![0] as Record<string, unknown>;
    const errorField = payload.error as Record<string, unknown>;
    expect(errorField.message).toBe('no such table: symbols');
    expect(errorField.code).toBe('SQLITE_ERROR');
  });
});
