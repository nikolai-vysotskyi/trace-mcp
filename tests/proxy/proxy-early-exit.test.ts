import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyProxyArgs,
  extractProxyArgs,
  isMainEntry,
  PKG_VERSION,
  PROXY_USAGE,
} from '../../src/proxy-entry.js';

describe('classifyProxyArgs (TRA-1739)', () => {
  it('classifies -h and --help as help with exitCode 0', () => {
    const resShort = classifyProxyArgs(['-h']);
    expect(resShort.action).toBe('help');
    expect(resShort.exitCode).toBe(0);
    expect(resShort.output).toBe(PROXY_USAGE);

    const resLong = classifyProxyArgs(['--help']);
    expect(resLong.action).toBe('help');
    expect(resLong.exitCode).toBe(0);
    expect(resLong.output).toBe(PROXY_USAGE);

    const resWithPrefix = classifyProxyArgs(['node', 'proxy.js', '--help']);
    expect(resWithPrefix.action).toBe('help');
    expect(resWithPrefix.exitCode).toBe(0);
  });

  it('classifies -v, -V, and --version as version with exitCode 0', () => {
    const resShort = classifyProxyArgs(['-v']);
    expect(resShort.action).toBe('version');
    expect(resShort.exitCode).toBe(0);
    expect(resShort.output).toBe(PKG_VERSION);

    const resUpper = classifyProxyArgs(['-V']);
    expect(resUpper.action).toBe('version');
    expect(resUpper.exitCode).toBe(0);
    expect(resUpper.output).toBe(PKG_VERSION);

    const resLong = classifyProxyArgs(['--version']);
    expect(resLong.action).toBe('version');
    expect(resLong.exitCode).toBe(0);
    expect(resLong.output).toBe(PKG_VERSION);

    const resWithPrefix = classifyProxyArgs(['node', 'proxy.js', '--version']);
    expect(resWithPrefix.action).toBe('version');
    expect(resWithPrefix.exitCode).toBe(0);
  });

  it('classifies unknown options as error with exitCode 1', () => {
    const resBogus = classifyProxyArgs(['--bogus']);
    expect(resBogus.action).toBe('error');
    expect(resBogus.exitCode).toBe(1);
    expect(resBogus.error).toBe("error: unknown option '--bogus'");
    expect(resBogus.output).toContain("error: unknown option '--bogus'");
    expect(resBogus.output).toContain('Usage: trace-mcp-proxy');

    // Missing preset value or flag following --preset
    const resPresetMissing = classifyProxyArgs(['--preset']);
    expect(resPresetMissing.action).toBe('error');
    expect(resPresetMissing.exitCode).toBe(1);
    expect(resPresetMissing.error).toBe("error: option '--preset <name>' argument missing");

    // --preset followed by another option: --bogus is classified as unknown
    const resPresetBogus = classifyProxyArgs(['--preset', '--bogus']);
    expect(resPresetBogus.action).toBe('error');
    expect(resPresetBogus.exitCode).toBe(1);
    expect(resPresetBogus.error).toBe("error: unknown option '--bogus'");
  });

  it('classifies unknown commands as error with exitCode 1', () => {
    const resUnknown = classifyProxyArgs(['unknown-command']);
    expect(resUnknown.action).toBe('error');
    expect(resUnknown.exitCode).toBe(1);
    expect(resUnknown.error).toBe("error: unknown command 'unknown-command'");
    expect(resUnknown.output).toContain("error: unknown command 'unknown-command'");
    expect(resUnknown.output).toContain('Usage: trace-mcp-proxy');
  });

  it('classifies valid serve and preset combinations as serve with exitCode 0', () => {
    expect(classifyProxyArgs([])).toEqual({ action: 'serve', type: 'serve', exitCode: 0 });
    expect(classifyProxyArgs(['serve'])).toEqual({ action: 'serve', type: 'serve', exitCode: 0 });
    expect(classifyProxyArgs(['serve', '--preset', 'minimal'])).toEqual({
      action: 'serve',
      type: 'serve',
      exitCode: 0,
    });
    expect(classifyProxyArgs(['--preset', 'full'])).toEqual({
      action: 'serve',
      type: 'serve',
      exitCode: 0,
    });
    expect(classifyProxyArgs(['--preset=review'])).toEqual({
      action: 'serve',
      type: 'serve',
      exitCode: 0,
    });
    expect(classifyProxyArgs(['node', 'proxy.js', 'serve', '--preset', 'minimal'])).toEqual({
      action: 'serve',
      type: 'serve',
      exitCode: 0,
    });
  });

  it('normalizes Windows node.exe / tsx.cmd paths in argv (TRA-1739 regression)', () => {
    const windowsNodeArgv = [
      'C:\\hostedtoolcache\\windows\\node\\22.23.3\\x64\\node.exe',
      'D:\\a\\trace-mcp\\trace-mcp\\src\\proxy-entry.ts',
      '--bogus-flag',
    ];
    expect(extractProxyArgs(windowsNodeArgv)).toEqual(['--bogus-flag']);
    const resBogus = classifyProxyArgs(windowsNodeArgv);
    expect(resBogus.action).toBe('error');
    expect(resBogus.exitCode).toBe(1);
    expect(resBogus.error).toBe("error: unknown option '--bogus-flag'");

    const windowsHelpArgv = [
      'C:\\hostedtoolcache\\windows\\node\\22.23.3\\x64\\node.exe',
      'D:\\a\\trace-mcp\\trace-mcp\\src\\proxy-entry.ts',
      '--help',
    ];
    expect(extractProxyArgs(windowsHelpArgv)).toEqual(['--help']);
    expect(classifyProxyArgs(windowsHelpArgv).action).toBe('help');

    const windowsVersionArgv = [
      'C:\\hostedtoolcache\\windows\\node\\22.23.3\\x64\\NODE.EXE',
      'D:\\a\\trace-mcp\\trace-mcp\\dist\\proxy.js',
      '--version',
    ];
    expect(extractProxyArgs(windowsVersionArgv)).toEqual(['--version']);
    expect(classifyProxyArgs(windowsVersionArgv).action).toBe('version');

    const windowsTsxArgv = [
      'C:\\tools\\tsx.cmd',
      'D:\\a\\trace-mcp\\trace-mcp\\src\\proxy-entry.ts',
      'serve',
      '--preset',
      'minimal',
    ];
    expect(extractProxyArgs(windowsTsxArgv)).toEqual(['serve', '--preset', 'minimal']);
    expect(classifyProxyArgs(windowsTsxArgv).action).toBe('serve');
  });
});

describe('isMainEntry guard (TRA-1739)', () => {
  it('returns false when argv[1] does not match module URL', () => {
    expect(isMainEntry(import.meta.url, '/different/path/script.js')).toBe(false);
    expect(isMainEntry(import.meta.url, undefined)).toBe(false);
  });

  it('returns true when argv[1] matches module path', () => {
    const selfPath = fileURLToPath(import.meta.url);
    expect(isMainEntry(import.meta.url, selfPath)).toBe(true);
  });
});

describe('proxy early exit subprocess execution (TRA-1739)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmphome-proxy-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function runProxy(args: string[]) {
    const tsxCli = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
    const script = path.resolve(__dirname, '../../src/proxy-entry.ts');
    return spawnSync(process.execPath, [tsxCli, script, ...args], {
      env: {
        ...process.env,
        TRACE_MCP_HOME: tmpHome,
        TRACE_MCP_DATA_DIR: tmpHome,
      },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  it('proxy.js --help prints usage to stdout, exit 0, empty stderr, no files created', () => {
    const start = Date.now();
    const res = runProxy(['--help']);
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage: trace-mcp-proxy');
    expect(res.stdout).toContain('Thin stdio proxy to the trace-mcp daemon.');
    expect(res.stderr).toBe('');
    expect(elapsedMs).toBeLessThan(5000);

    // No files or directories created in TRACE_MCP_HOME
    const files = fs.readdirSync(tmpHome);
    expect(files).toEqual([]);
  });

  it('proxy.js --version prints version to stdout, exit 0, empty stderr', () => {
    const res = runProxy(['--version']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(PKG_VERSION);
    expect(res.stderr).toBe('');
  });

  it('proxy.js with unknown flag prints error and usage to stderr, exit 1, empty stdout', () => {
    const res = runProxy(['--bogus-flag']);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain("error: unknown option '--bogus-flag'");
    expect(res.stderr).toContain('Usage: trace-mcp-proxy');
  });
});
