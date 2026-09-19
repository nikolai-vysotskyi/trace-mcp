/**
 * TRA-1607 (PROC-3): doctor's process inventory — classification, duplicate
 * and orphan detection over synthetic `ps` output. No real processes are
 * listed or killed here; `listTraceMcpProcesses`/`signalDaemons` touch the
 * machine and stay untested by unit tests (covered by the manual
 * "2 spawns → 1 daemon" check in the issue).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyTraceMcpCommand,
  diagnoseProcesses,
  formatProcessReport,
  isTraceMcpCommand,
  parseEtime,
  parsePsOutput,
  type TraceMcpProcess,
} from '../process-inventory.js';

function proc(overrides: Partial<TraceMcpProcess> & { pid: number }): TraceMcpProcess {
  return {
    ppid: 100,
    rssBytes: 400 * 1024 * 1024,
    ageSec: 3600,
    command: '/Users/x/.trace-mcp/bin/trace-mcp serve-http --port 3741',
    role: 'daemon',
    isSelf: false,
    ...overrides,
  };
}

describe('isTraceMcpCommand', () => {
  it('matches shim, cli.js and serve-http invocations', () => {
    expect(isTraceMcpCommand('/Users/x/.trace-mcp/bin/trace-mcp serve-http --port 3741')).toBe(
      true,
    );
    expect(isTraceMcpCommand('/opt/node/bin/node /app/dist/cli.js serve')).toBe(true);
    expect(
      isTraceMcpCommand('/Applications/Trace.app/bin/node-runtime /res/dist/cli.js doctor'),
    ).toBe(true);
  });

  it('rejects unrelated processes', () => {
    expect(isTraceMcpCommand('/usr/sbin/cupsd')).toBe(false);
    expect(isTraceMcpCommand('postgres: checkpointer')).toBe(false);
  });
});

describe('classifyTraceMcpCommand', () => {
  it('labels serve-http as daemon with its port', () => {
    expect(classifyTraceMcpCommand('/bin/trace-mcp serve-http --port 3741')).toEqual({
      role: 'daemon',
      port: 3741,
    });
    expect(classifyTraceMcpCommand('node /res/dist/cli.js serve-http --port=37497')).toEqual({
      role: 'daemon',
      port: 37497,
    });
  });

  it('does not mistake the serve inside serve-http for a session', () => {
    expect(classifyTraceMcpCommand('x serve-http').role).toBe('daemon');
  });

  it('labels serve and the thin proxy as stdio sessions', () => {
    expect(classifyTraceMcpCommand('/bin/trace-mcp serve').role).toBe('stdio-session');
    expect(classifyTraceMcpCommand('node /app/dist/proxy.js --preset full').role).toBe(
      'stdio-session',
    );
  });

  it('labels one-shot invocations as cli', () => {
    expect(classifyTraceMcpCommand('/bin/trace-mcp doctor --json').role).toBe('cli');
  });

  it('labels the Electron app and its helpers as desktop-app', () => {
    expect(
      classifyTraceMcpCommand('/Users/n/Applications/trace-mcp.app/Contents/MacOS/trace-mcp').role,
    ).toBe('desktop-app');
    expect(
      classifyTraceMcpCommand(
        '/Users/n/Applications/trace-mcp.app/Contents/Frameworks/trace-mcp Helper.app/Contents/MacOS/trace-mcp Helper --type=gpu-process',
      ).role,
    ).toBe('desktop-app');
  });

  it('a serving role wins over the desktop-app path (staged server)', () => {
    expect(
      classifyTraceMcpCommand(
        '/Applications/trace.app/Contents/Resources/server/dist/cli.js serve-http --port 3741',
      ).role,
    ).toBe('daemon');
  });

  it('labels non-trace commands unknown', () => {
    expect(classifyTraceMcpCommand('/usr/bin/ssh-agent').role).toBe('unknown');
  });
});

describe('parseEtime', () => {
  it('parses MM:SS, HH:MM:SS and D-HH:MM:SS', () => {
    expect(parseEtime('05:56')).toBe(356);
    expect(parseEtime('5:56:12')).toBe(21372);
    expect(parseEtime('2-05:56:12')).toBe(194172);
  });

  it('returns null for garbage', () => {
    expect(parseEtime('???')).toBeNull();
  });
});

describe('parsePsOutput', () => {
  const PS = [
    '  36600     1  412672 5:56:12 /Users/n/.trace-mcp/bin/trace-mcp serve-http --port 3741',
    '  57790 36600   98304 01:12:33 /Users/n/.trace-mcp/bin/trace-mcp serve',
    '  58960    50    2048 00:00:05 /bin/trace-mcp doctor',
    '    100     1    1024 00:01:00 /usr/sbin/cupsd',
  ].join('\n');

  it('keeps trace-mcp lines with role, RSS and age', () => {
    const found = parsePsOutput(PS);
    expect(found.map((p) => p.pid)).toEqual([36600, 57790, 58960]);
    const daemon = found[0];
    expect(daemon.role).toBe('daemon');
    expect(daemon.port).toBe(3741);
    expect(daemon.rssBytes).toBe(412672 * 1024);
    expect(daemon.ageSec).toBe(5 * 3600 + 56 * 60 + 12);
    expect(found[1].role).toBe('stdio-session');
    expect(found[2].role).toBe('cli');
  });

  it('never reports the listing process itself', () => {
    const line = `  ${process.pid}     1  412672 00:01:00 /bin/trace-mcp serve-http --port 3741`;
    expect(parsePsOutput(line)).toEqual([]);
  });
});

describe('diagnoseProcesses', () => {
  it('is quiet with a single registered daemon', () => {
    const r = diagnoseProcesses([proc({ pid: 100 })], { registeredPid: 100 });
    expect(r.daemons).toHaveLength(1);
    expect(r.duplicates).toEqual([]);
    expect(r.orphans).toEqual([]);
  });

  it('flags every daemon but the registered one as duplicate', () => {
    const r = diagnoseProcesses(
      [proc({ pid: 100, ageSec: 7200 }), proc({ pid: 200, ageSec: 60, port: 3741 })],
      { registeredPid: 100 },
    );
    expect(r.duplicates.map((d) => d.pid)).toEqual([200]);
  });

  it('keeps the oldest daemon when nothing is registered', () => {
    const r = diagnoseProcesses([proc({ pid: 100, ageSec: 7200 }), proc({ pid: 200, ageSec: 60 })]);
    expect(r.duplicates.map((d) => d.pid)).toEqual([200]);
  });

  it('flags reparented stdio sessions as orphans', () => {
    const r = diagnoseProcesses([
      proc({ pid: 100 }),
      proc({ pid: 300, ppid: 1, role: 'stdio-session', command: 'x serve' }),
      proc({ pid: 400, ppid: 500, role: 'stdio-session', command: 'x serve' }),
    ]);
    expect(r.orphans.map((o) => o.pid)).toEqual([300]);
  });

  it('never calls a lone ppid-1 daemon an orphan (launchd/detached normal state)', () => {
    const r = diagnoseProcesses([proc({ pid: 100, ppid: 1 })], { launchdLoaded: true });
    expect(r.orphans).toEqual([]);
    const r2 = diagnoseProcesses([proc({ pid: 100, ppid: 1 })]);
    expect(r2.orphans).toEqual([]);
  });
});

describe('formatProcessReport', () => {
  it('names duplicates and orphans in plain words', () => {
    const r = diagnoseProcesses(
      [
        proc({ pid: 100, ageSec: 7200 }),
        proc({ pid: 200, ageSec: 60 }),
        proc({ pid: 300, ppid: 1, role: 'stdio-session', command: 'x serve' }),
      ],
      { registeredPid: 100 },
    );
    const text = formatProcessReport(r).join('\n');
    expect(text).toMatch(/pid 200.*DUPLICATE daemon/);
    expect(text).toMatch(/pid 300.*ORPHAN/);
    expect(text).toMatch(/single-daemon invariant broken/);
  });
});
