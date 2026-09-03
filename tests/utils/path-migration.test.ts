import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNotSymlink,
  isSymlink,
  migrateClientConfigServers,
  migrateDirectorySafely,
  migrateProjectConfig,
  migrateToolNamePrefixInFile,
} from '../../src/utils/path-migration.js';
import { atomicWriteString } from '../../src/utils/atomic-write.js';

const IS_WINDOWS = process.platform === 'win32';

describe('Path and Directory Migration Security', () => {
  let tempDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trace-migration-test-'));
    srcDir = join(tempDir, 'src-dir');
    destDir = join(tempDir, 'dest-dir');
    mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Symlink Safety Checks', () => {
    it('detects symlinks accurately with isSymlink', () => {
      const realFile = join(tempDir, 'real.txt');
      const linkFile = join(tempDir, 'link.txt');
      writeFileSync(realFile, 'data');
      symlinkSync(realFile, linkFile);

      expect(isSymlink(realFile)).toBe(false);
      expect(isSymlink(linkFile)).toBe(true);
      expect(isSymlink(join(tempDir, 'non-existent.txt'))).toBe(false);
    });

    it('throws security violation in assertNotSymlink when symlink is passed', () => {
      const realFile = join(tempDir, 'real.txt');
      const linkFile = join(tempDir, 'link.txt');
      writeFileSync(realFile, 'data');
      symlinkSync(realFile, linkFile);

      expect(() => assertNotSymlink(realFile)).not.toThrow();
      expect(() => assertNotSymlink(linkFile)).toThrow(/Security Violation.*symlink/);
    });

    it('refuses to migrate when source directory is a symlink', () => {
      const targetDir = join(tempDir, 'real-src');
      mkdirSync(targetDir);
      writeFileSync(join(targetDir, 'config.json'), '{"key":"val"}');

      const symlinkSrc = join(tempDir, 'symlink-src');
      symlinkSync(targetDir, symlinkSrc);

      const result = migrateDirectorySafely(symlinkSrc, destDir);
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e) => e.includes('Source directory') && e.includes('symlink')),
      ).toBe(true);
      expect(existsSync(destDir)).toBe(false);
    });

    it('refuses to migrate when destination directory is an existing symlink', () => {
      writeFileSync(join(srcDir, 'config.json'), '{"key":"val"}');

      const evilTarget = join(tempDir, 'evil-target');
      mkdirSync(evilTarget);
      symlinkSync(evilTarget, destDir);

      const result = migrateDirectorySafely(srcDir, destDir);
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e) => e.includes('Destination directory') && e.includes('symlink')),
      ).toBe(true);
      expect(existsSync(join(evilTarget, 'config.json'))).toBe(false);
    });

    it('skips symlinked files inside the source directory without following them', () => {
      const sensitiveFile = join(tempDir, 'sensitive-shadow.txt');
      writeFileSync(sensitiveFile, 'SECRET_SYSTEM_DATA');

      const normalFile = join(srcDir, 'normal.json');
      writeFileSync(normalFile, '{"public":true}');

      const evilSymlink = join(srcDir, 'shadow-symlink.txt');
      symlinkSync(sensitiveFile, evilSymlink);

      const result = migrateDirectorySafely(srcDir, destDir);
      expect(result.success).toBe(true);

      // Normal file was migrated
      expect(existsSync(join(destDir, 'normal.json'))).toBe(true);

      // Symlink was skipped
      expect(existsSync(join(destDir, 'shadow-symlink.txt'))).toBe(false);
      expect(
        result.skipped.some(
          (s) => s.reason === 'symlink' && s.source.includes('shadow-symlink.txt'),
        ),
      ).toBe(true);
    });
  });

  describe('POSIX Permission Enforcement', () => {
    it('applies 0700 permissions to migrated directory and subdirectories', () => {
      if (IS_WINDOWS) return;

      mkdirSync(join(srcDir, 'index', 'sub'), { recursive: true });
      writeFileSync(join(srcDir, 'index', 'sub', 'item.txt'), 'data');

      const result = migrateDirectorySafely(srcDir, destDir);
      expect(result.success).toBe(true);

      const destStat = statSync(destDir);
      expect(destStat.mode & 0o777).toBe(0o700);

      const subStat = statSync(join(destDir, 'index'));
      expect(subStat.mode & 0o777).toBe(0o700);

      const deepStat = statSync(join(destDir, 'index', 'sub'));
      expect(deepStat.mode & 0o777).toBe(0o700);
    });

    it('applies 0600 to database and config files and 0755 to bin executables', () => {
      if (IS_WINDOWS) return;

      mkdirSync(join(srcDir, 'bin'), { recursive: true });
      writeFileSync(join(srcDir, 'bin', 'trace'), '#!/bin/bash\necho ok');
      writeFileSync(join(srcDir, '.config.json'), '{"tools":"minimal"}');
      writeFileSync(join(srcDir, 'topology.db'), 'SQLITE_HEADER');

      const result = migrateDirectorySafely(srcDir, destDir);
      expect(result.success).toBe(true);

      const binStat = statSync(join(destDir, 'bin', 'trace'));
      expect(binStat.mode & 0o777).toBe(0o755);

      const configStat = statSync(join(destDir, '.config.json'));
      expect(configStat.mode & 0o777).toBe(0o600);

      const dbStat = statSync(join(destDir, 'topology.db'));
      expect(dbStat.mode & 0o777).toBe(0o600);
    });
  });

  describe('SQLite Database and Sidecar Migration', () => {
    it('bundles SQLite database with WAL and SHM sidecars atomically', () => {
      writeFileSync(join(srcDir, 'decisions.db'), 'MAIN_DB');
      writeFileSync(join(srcDir, 'decisions.db-wal'), 'WAL_JOURNAL');
      writeFileSync(join(srcDir, 'decisions.db-shm'), 'SHM_INDEX');

      const result = migrateDirectorySafely(srcDir, destDir);
      expect(result.success).toBe(true);

      expect(readFileSync(join(destDir, 'decisions.db'), 'utf8')).toBe('MAIN_DB');
      expect(readFileSync(join(destDir, 'decisions.db-wal'), 'utf8')).toBe('WAL_JOURNAL');
      expect(readFileSync(join(destDir, 'decisions.db-shm'), 'utf8')).toBe('SHM_INDEX');

      if (!IS_WINDOWS) {
        expect(statSync(join(destDir, 'decisions.db')).mode & 0o777).toBe(0o600);
        expect(statSync(join(destDir, 'decisions.db-wal')).mode & 0o777).toBe(0o600);
        expect(statSync(join(destDir, 'decisions.db-shm')).mode & 0o777).toBe(0o600);
      }
    });

    // TRA-732: the copy path used to round-trip through a UTF-8 string, which
    // maps every invalid byte to U+FFFD (1 byte in, 3 out). The five tests
    // above all pass on a file corrupted that way because their fixtures are
    // ASCII. A real database is not.
    it('copies a database and its sidecars byte-for-byte', () => {
      const dbBytes = Buffer.concat([
        Buffer.from('SQLite format 3\0', 'binary'),
        Buffer.from([0x10, 0x00, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20, 0xff, 0xfe, 0x80, 0x81]),
      ]);
      const walBytes = Buffer.from([0x37, 0x7f, 0x06, 0x82, 0xff, 0xc0, 0x00, 0xed]);
      writeFileSync(join(srcDir, 'state.db'), dbBytes);
      writeFileSync(join(srcDir, 'state.db-wal'), walBytes);

      const result = migrateDirectorySafely(srcDir, destDir);
      expect(result.success).toBe(true);

      expect(readFileSync(join(destDir, 'state.db'))).toEqual(dbBytes);
      expect(readFileSync(join(destDir, 'state.db-wal'))).toEqual(walBytes);
    });

    it('copies a non-database binary file without appending a newline', () => {
      const blob = Buffer.from([0x00, 0xff, 0x0a, 0x80, 0x7f]);
      writeFileSync(join(srcDir, 'cache.bin'), blob);

      const result = migrateDirectorySafely(srcDir, destDir);
      expect(result.success).toBe(true);
      expect(readFileSync(join(destDir, 'cache.bin'))).toEqual(blob);
    });
  });

  describe('Project Config (.trace-mcp.json -> .trace.json) Migration', () => {
    it('migrates .trace-mcp.json to .trace.json and preserves permissions', () => {
      const projDir = join(tempDir, 'project');
      mkdirSync(projDir);
      const legacyPath = join(projDir, '.trace-mcp.json');
      writeFileSync(legacyPath, '{"tools":{"preset":"minimal"}}');
      if (!IS_WINDOWS) chmodSync(legacyPath, 0o600);

      const res = migrateProjectConfig(projDir);
      expect(res.migrated).toBe(true);
      expect(res.action).toBe('created');

      const newPath = join(projDir, '.trace.json');
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(newPath, 'utf8')).toBe('{"tools":{"preset":"minimal"}}\n');

      if (!IS_WINDOWS) {
        expect(statSync(newPath).mode & 0o777).toBe(0o600);
      }
    });

    it('does not overwrite existing .trace.json', () => {
      const projDir = join(tempDir, 'project');
      mkdirSync(projDir);
      writeFileSync(join(projDir, '.trace-mcp.json'), '{"version":1}');
      writeFileSync(join(projDir, '.trace.json'), '{"version":2}');

      const res = migrateProjectConfig(projDir);
      expect(res.migrated).toBe(false);
      expect(res.action).toBe('already_present');
      expect(readFileSync(join(projDir, '.trace.json'), 'utf8')).toBe('{"version":2}');
    });

    it('refuses to migrate if legacy config is a symlink', () => {
      const projDir = join(tempDir, 'project');
      mkdirSync(projDir);
      const realConfig = join(tempDir, 'foreign-config.json');
      writeFileSync(realConfig, '{"hacked":true}');
      symlinkSync(realConfig, join(projDir, '.trace-mcp.json'));

      const res = migrateProjectConfig(projDir);
      expect(res.migrated).toBe(false);
      expect(res.action).toBe('skipped');
      expect(existsSync(join(projDir, '.trace.json'))).toBe(false);
    });
  });

  describe('Client Config (mcpServers[trace-mcp] -> mcpServers[trace]) Migration', () => {
    it('renames trace-mcp server entry to trace while preserving other servers and formatting', () => {
      const clientConfig = join(tempDir, 'claude.json');
      const initial = {
        mcpServers: {
          'other-server': { command: 'other' },
          'trace-mcp': { command: '~/.trace/bin/trace', args: ['serve'] },
        },
      };
      writeFileSync(clientConfig, JSON.stringify(initial, null, 2));

      const res = migrateClientConfigServers(clientConfig);
      expect(res.migrated).toBe(true);

      const updated = JSON.parse(readFileSync(clientConfig, 'utf8'));
      expect(updated.mcpServers['trace-mcp']).toBeUndefined();
      expect(updated.mcpServers.trace).toEqual({ command: '~/.trace/bin/trace', args: ['serve'] });
      expect(updated.mcpServers['other-server']).toEqual({ command: 'other' });
    });

    it('refuses to rewrite client config if it is a symlink', () => {
      const realFile = join(tempDir, 'real-client.json');
      const symlinkFile = join(tempDir, 'symlink-client.json');
      writeFileSync(realFile, JSON.stringify({ mcpServers: { 'trace-mcp': { command: 'x' } } }));
      symlinkSync(realFile, symlinkFile);

      const res = migrateClientConfigServers(symlinkFile);
      expect(res.migrated).toBe(false);
      expect(res.error).toMatch(/symlink/);
    });
  });

  describe('Tool Name Prefix (mcp__trace-mcp__* -> mcp__trace__*) Migration', () => {
    it('rewrites a permission allowlist entry naming the legacy tool prefix', () => {
      const settingsPath = join(tempDir, 'settings.json');
      const original =
        '{\n  "permissions": {\n    "allow": [\n      "mcp__trace-mcp__search",\n      "Bash(git status)"\n    ]\n  }\n}\n';
      writeFileSync(settingsPath, original);

      const res = migrateToolNamePrefixInFile(settingsPath);
      expect(res.migrated).toBe(true);
      expect(res.occurrences).toBe(1);

      const updated = readFileSync(settingsPath, 'utf8');
      expect(updated).toBe(original.replace('mcp__trace-mcp__search', 'mcp__trace__search'));
      const parsed = JSON.parse(updated);
      expect(parsed.permissions.allow).toEqual(['mcp__trace__search', 'Bash(git status)']);
    });

    it('rewrites every occurrence in a hook matcher string and counts them', () => {
      const settingsPath = join(tempDir, 'settings.json');
      const original = JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'mcp__trace-mcp__search|mcp__trace-mcp__get_symbol',
              hooks: [{ type: 'command', command: '/bin/my-custom-hook.sh' }],
            },
          ],
        },
      });
      writeFileSync(settingsPath, original);

      const res = migrateToolNamePrefixInFile(settingsPath);
      expect(res.migrated).toBe(true);
      expect(res.occurrences).toBe(2);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(parsed.hooks.PreToolUse[0].matcher).toBe('mcp__trace__search|mcp__trace__get_symbol');
      // Untouched sibling content survives verbatim.
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('/bin/my-custom-hook.sh');
    });

    it('preserves unrelated content and formatting byte-for-byte, including no trailing newline', () => {
      const settingsPath = join(tempDir, 'settings.json');
      // Irregular indentation and no trailing newline — content trace-mcp does
      // not own the shape of, so a JSON.parse + stringify round-trip would
      // silently reformat it. Must come back identical apart from the prefix.
      const original =
        '{"weird":   "spacing",\n"permissions":{"allow":["mcp__trace-mcp__search"]},\n"nested":{"deep":{"value":42}}}';
      writeFileSync(settingsPath, original);

      const res = migrateToolNamePrefixInFile(settingsPath);
      expect(res.migrated).toBe(true);

      const updated = readFileSync(settingsPath, 'utf8');
      expect(updated).toBe(original.replace('mcp__trace-mcp__search', 'mcp__trace__search'));
      expect(updated.endsWith('\n')).toBe(false);
    });

    it('is a no-op and does not write when the legacy prefix is absent', () => {
      const settingsPath = join(tempDir, 'settings.json');
      const original = '{"permissions":{"allow":["mcp__trace__search"]}}';
      writeFileSync(settingsPath, original);
      const before = statSync(settingsPath).mtimeMs;

      const res = migrateToolNamePrefixInFile(settingsPath);
      expect(res.migrated).toBe(false);
      expect(res.occurrences).toBe(0);
      expect(readFileSync(settingsPath, 'utf8')).toBe(original);
      expect(statSync(settingsPath).mtimeMs).toBe(before);
    });

    it('returns migrated:false without error for a file that does not exist', () => {
      const res = migrateToolNamePrefixInFile(join(tempDir, 'nope.json'));
      expect(res.migrated).toBe(false);
      expect(res.occurrences).toBe(0);
      expect(res.error).toBeUndefined();
    });

    it('dry-run reports the migration without writing', () => {
      const settingsPath = join(tempDir, 'settings.json');
      const original = '{"permissions":{"allow":["mcp__trace-mcp__search"]}}';
      writeFileSync(settingsPath, original);

      const res = migrateToolNamePrefixInFile(settingsPath, undefined, undefined, {
        dryRun: true,
      });
      expect(res.migrated).toBe(true);
      expect(res.occurrences).toBe(1);
      expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    });

    it('refuses to write through a symlink', () => {
      const realFile = join(tempDir, 'real-settings.json');
      const symlinkFile = join(tempDir, 'settings.json');
      writeFileSync(
        realFile,
        JSON.stringify({ permissions: { allow: ['mcp__trace-mcp__search'] } }),
      );
      symlinkSync(realFile, symlinkFile);

      const res = migrateToolNamePrefixInFile(symlinkFile);
      expect(res.migrated).toBe(false);
      expect(res.error).toMatch(/symlink/);
      // The real file behind the symlink was never touched either.
      expect(readFileSync(realFile, 'utf8')).toContain('mcp__trace-mcp__search');
    });

    it('preserves the file mode on rewrite', () => {
      if (IS_WINDOWS) return;
      const settingsPath = join(tempDir, 'settings.json');
      writeFileSync(settingsPath, '{"permissions":{"allow":["mcp__trace-mcp__search"]}}');
      chmodSync(settingsPath, 0o644);

      migrateToolNamePrefixInFile(settingsPath);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o644);
    });
  });

  describe('Atomic Write Permission Preservation', () => {
    it('preserves existing 0600 mode on rewrite when opts.mode is omitted', () => {
      if (IS_WINDOWS) return;

      const secretFile = join(tempDir, 'secret-config.json');
      atomicWriteString(secretFile, '{"token":"initial"}', { mode: 0o600 });
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);

      // Rewrite without passing mode
      atomicWriteString(secretFile, '{"token":"updated"}');
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(secretFile, 'utf8')).toBe('{"token":"updated"}\n');
    });
  });
});
