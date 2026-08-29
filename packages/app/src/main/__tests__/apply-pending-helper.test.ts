import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { hasPendingUpdate, trySpawnApplyHelper } from '../apply-pending-helper';

describe('apply-pending-helper', () => {
  let dir: string;
  let pendingZip: string;
  let pendingVersion: string;
  let applyHelper: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-apply-helper-test-'));
    pendingZip = path.join(dir, '.trace-mcp-pending.zip');
    pendingVersion = path.join(dir, '.trace-mcp-pending-version');
    applyHelper = path.join(dir, 'apply-pending-update.mjs');
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hasPendingUpdate is false when nothing is staged', () => {
    expect(hasPendingUpdate({ pendingZip, pendingVersion })).toBe(false);
  });

  it('hasPendingUpdate is true once both the zip and version marker exist', () => {
    fs.writeFileSync(pendingZip, 'zip-bytes');
    fs.writeFileSync(pendingVersion, '9.9.9');
    expect(hasPendingUpdate({ pendingZip, pendingVersion })).toBe(true);
  });

  it('does not spawn the helper when there is no pending update', () => {
    fs.writeFileSync(applyHelper, '// noop');
    const spawned = trySpawnApplyHelper(
      { pendingZip, pendingVersion, applyHelper },
      4242,
      'zip-staged',
    );
    expect(spawned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not spawn the helper when the helper script is missing on disk', () => {
    fs.writeFileSync(pendingZip, 'zip-bytes');
    fs.writeFileSync(pendingVersion, '9.9.9');
    const spawned = trySpawnApplyHelper(
      { pendingZip, pendingVersion, applyHelper: path.join(dir, 'missing.mjs') },
      4242,
      'zip-staged',
    );
    expect(spawned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns the detached helper with the given pid when an update is staged', () => {
    fs.writeFileSync(pendingZip, 'zip-bytes');
    fs.writeFileSync(pendingVersion, '9.9.9');
    fs.writeFileSync(applyHelper, '// noop');
    vi.mocked(spawn).mockReturnValue({
      unref: vi.fn(),
      pid: 555,
    } as unknown as ReturnType<typeof spawn>);

    const spawned = trySpawnApplyHelper(
      { pendingZip, pendingVersion, applyHelper },
      4242,
      'zip-staged',
    );

    expect(spawned).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(args).toEqual([applyHelper, '4242']);
    expect((opts as { detached?: boolean }).detached).toBe(true);
  });

  it('returns false (not throw) when spawn itself throws', () => {
    fs.writeFileSync(pendingZip, 'zip-bytes');
    fs.writeFileSync(pendingVersion, '9.9.9');
    fs.writeFileSync(applyHelper, '// noop');
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() =>
      trySpawnApplyHelper({ pendingZip, pendingVersion, applyHelper }, 4242, 'zip-staged'),
    ).not.toThrow();
    expect(
      trySpawnApplyHelper({ pendingZip, pendingVersion, applyHelper }, 4242, 'zip-staged'),
    ).toBe(false);
  });
});
