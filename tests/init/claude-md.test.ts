import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');
const mockFs = vi.mocked(fs);

let updateClaudeMd: typeof import('../../src/init/claude-md.js').updateClaudeMd;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mockFs.existsSync.mockReturnValue(false);
  mockFs.writeFileSync.mockImplementation(() => {});
  mockFs.readFileSync.mockReturnValue('');
  mockFs.mkdirSync.mockImplementation(() => undefined as unknown as string);

  const mod = await import('../../src/init/claude-md.js');
  updateClaudeMd = mod.updateClaudeMd;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const START_MARKER = '<!-- trace-mcp:start -->';
const END_MARKER = '<!-- trace-mcp:end -->';

describe('updateClaudeMd', () => {
  it('returns skipped on dry run when file does not exist', () => {
    const result = updateClaudeMd('/project', { dryRun: true });
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('Would create');
  });

  it('returns skipped on dry run when file has existing block', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      `Some content\n${START_MARKER}\nold block\n${END_MARKER}\n`,
    );

    const result = updateClaudeMd('/project', { dryRun: true });
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('Would update');
  });

  it('returns skipped on dry run for append case', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('Some content without markers\n');

    const result = updateClaudeMd('/project', { dryRun: true });
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('Would append');
  });

  it('creates new CLAUDE.md when file does not exist', () => {
    const result = updateClaudeMd('/project', {});
    expect(result.action).toBe('created');
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();

    const content = String(mockFs.writeFileSync.mock.calls[0][1]);
    expect(content).toContain(START_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('trace-mcp Tool Routing');
  });

  it('uses global path when scope is global', () => {
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = '/home/user';
    // os.homedir() reads USERPROFILE on Windows; set both so the production
    // code under test resolves to the same fake home regardless of platform.
    process.env.USERPROFILE = '/home/user';

    const result = updateClaudeMd('/project', { scope: 'global' });
    // path.join uses native separator; assert against the platform-correct
    // form so the test doesn't bake in POSIX expectations.
    expect(result.target).toContain(path.join('.claude', 'CLAUDE.md'));

    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
  });

  it('replaces existing block between markers', () => {
    const existing = `# My Project\n\n${START_MARKER}\nold content\n${END_MARKER}\n\n## Other stuff\n\nKeep this content.\n`;
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existing);

    const result = updateClaudeMd('/project', {});
    expect(result.action).toBe('updated');

    const written = String(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written).toContain(START_MARKER);
    expect(written).toContain(END_MARKER);
    expect(written).not.toContain('old content');
    expect(written).toContain('## Other stuff');
  });

  it('appends block when no markers exist', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('# Existing content\n\nSome text\n');

    const result = updateClaudeMd('/project', {});
    expect(result.action).toBe('updated');
    expect(result.detail).toContain('Appended');

    const written = String(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written).toContain('# Existing content');
    expect(written).toContain(START_MARKER);
  });

  it('removes competing tool marker blocks', () => {
    const existing = `# Project\n\n<!-- jcodemunch:start -->\njcodemunch stuff\n<!-- jcodemunch:end -->\n\n${START_MARKER}\nold\n${END_MARKER}\n`;
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existing);

    const result = updateClaudeMd('/project', {});
    const written = String(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written).not.toContain('jcodemunch');
    expect(written).toContain(START_MARKER);
    expect(result.detail).toContain('competing');
  });

  it('removes competing tool heading sections', () => {
    const existing = `# Project\n\n## jCodeMunch\n\nSome jcodemunch config\n\n## Other\n\nKeep this\n`;
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existing);

    updateClaudeMd('/project', {});
    const written = String(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written).not.toContain('jCodeMunch');
    expect(written).toContain('## Other');
    expect(written).toContain('Keep this');
  });

  it('returns already_configured when block is identical', () => {
    // We need the actual block content — simulate by writing then re-reading
    mockFs.existsSync.mockReturnValue(false);
    updateClaudeMd('/project', {}); // creates the file

    const created = String(mockFs.writeFileSync.mock.calls[0][1]);
    vi.resetAllMocks();

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(created);
    mockFs.writeFileSync.mockImplementation(() => {});

    const result = updateClaudeMd('/project', {});
    expect(result.action).toBe('already_configured');
  });
});
