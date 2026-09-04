/* TRA-806: `daemon restart` takes 6-20 s to return on this machine, and until
   this test existed the Electron main process ran it with execFileSync — so the
   whole app froze for all of it. That is not a theoretical cost: the freeze
   lands on the first launch after an app update, when the tray poll sees the
   still-old daemon and restarts it, and the renderer's own clock measured 5.7 s
   to first content on exactly the launch that printed "version mismatch".

   The guard is behavioural rather than a grep for `execFileSync`: it runs a real
   child that takes its time and asserts the event loop kept turning meanwhile. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { restartDaemon, stopDaemon } from '../daemon-lifecycle';

// Force the TRACE_MCP_BIN branch: with a launcher.env on the machine,
// resolveCliInvocation would otherwise point at the real installed CLI.
vi.mock('../daemon-install', () => ({
  resolveCliInvocation: () => ({ file: '', prefixArgs: [] }),
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-lifecycle-'));
const slowBin = path.join(dir, 'slow-cli');
const previousBin = process.env.TRACE_MCP_BIN;

beforeAll(() => {
  fs.writeFileSync(slowBin, '#!/bin/sh\nsleep 0.4\n', { mode: 0o755 });
  process.env.TRACE_MCP_BIN = slowBin;
});

afterAll(() => {
  if (previousBin === undefined) delete process.env.TRACE_MCP_BIN;
  else process.env.TRACE_MCP_BIN = previousBin;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('daemon commands do not block the main process', () => {
  it.skipIf(process.platform === 'win32')('lets timers run while the CLI works', async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 50);
    const started = Date.now();
    const result = await restartDaemon();
    clearInterval(timer);

    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    // execFileSync would have delivered zero of these.
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  it.skipIf(process.platform === 'win32')('runs one command at a time', async () => {
    const order: string[] = [];
    const first = restartDaemon().then(() => order.push('first'));
    const second = stopDaemon().then(() => order.push('second'));
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });
});
