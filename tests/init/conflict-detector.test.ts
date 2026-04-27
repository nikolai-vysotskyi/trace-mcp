import { describe, it, expect, afterEach } from 'vitest';
import { detectConflicts } from '../../src/init/conflict-detector.js';
import { createTmpFixture, removeTmpDir } from '../test-utils.js';

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) removeTmpDir(d);
  tmpDirs = [];
});

function fixture(files: Record<string, string>): string {
  const dir = createTmpFixture(files);
  tmpDirs.push(dir);
  return dir;
}

describe('detectConflicts', () => {
  it('returns a conflict report with expected shape', () => {
    const report = detectConflicts(process.cwd());

    expect(report).toHaveProperty('conflicts');
    expect(report).toHaveProperty('scannedAt');
    expect(Array.isArray(report.conflicts)).toBe(true);
  });

  it('each conflict has required fields', () => {
    const report = detectConflicts(process.cwd());
    for (const c of report.conflicts) {
      expect(c).toHaveProperty('severity');
      expect(c).toHaveProperty('category');
      expect(c).toHaveProperty('summary');
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('competitor');
      expect(c).toHaveProperty('target');
      expect(c).toHaveProperty('fixable');
      expect(['critical', 'warning', 'info']).toContain(c.severity);
    }
  });

  it('does not crash on nonexistent project root', () => {
    const report = detectConflicts('/tmp/nonexistent-dir-xyz-99999');
    expect(Array.isArray(report.conflicts)).toBe(true);
  });

  it('returns scannedAt and projectRoot metadata', () => {
    const root = fixture({});
    const report = detectConflicts(root);
    expect(typeof report.scannedAt).toBe('string');
    expect(report.projectRoot).toBe(root);
  });

  // --- MCP server configs ---

  it('detects competing MCP server in .mcp.json', () => {
    const root = fixture({
      '.mcp.json': JSON.stringify({
        mcpServers: {
          'jcodemunch-mcp': { command: 'jcodemunch', args: [] },
          'trace-mcp': { command: 'trace-mcp', args: [] },
        },
      }),
    });

    const report = detectConflicts(root);
    const mcpConflicts = report.conflicts.filter((c) => c.category === 'mcp_server');
    expect(mcpConflicts.length).toBeGreaterThanOrEqual(1);

    const jcm = mcpConflicts.find((c) => c.competitor === 'jcodemunch-mcp');
    expect(jcm).toBeDefined();
    expect(jcm!.severity).toBe('critical');
    expect(jcm!.fixable).toBe(true);
  });

  it('detects repomix MCP server', () => {
    const root = fixture({
      '.mcp.json': JSON.stringify({
        mcpServers: { repomix: { command: 'repomix' } },
      }),
    });

    const report = detectConflicts(root);
    const repomix = report.conflicts.find(
      (c) => c.competitor === 'repomix' && c.category === 'mcp_server',
    );
    expect(repomix).toBeDefined();
  });

  it('ignores unknown MCP servers', () => {
    const root = fixture({
      '.mcp.json': JSON.stringify({
        mcpServers: { 'my-custom-server': { command: 'foo' } },
      }),
    });

    const report = detectConflicts(root);
    const mcpConflicts = report.conflicts.filter(
      (c) => c.category === 'mcp_server' && c.target.startsWith(root),
    );
    expect(mcpConflicts).toHaveLength(0);
  });

  it('handles malformed .mcp.json gracefully', () => {
    const root = fixture({ '.mcp.json': 'not valid json {{{' });
    const report = detectConflicts(root);
    // Should not throw
    expect(Array.isArray(report.conflicts)).toBe(true);
  });

  // --- Project config files ---

  it('detects competing project config files', () => {
    const root = fixture({
      '.jcodemunch.jsonc': '{}',
      '.aiderignore': '*.pyc',
      'repomix.config.json': '{}',
    });

    const report = detectConflicts(root);
    const configConflicts = report.conflicts.filter(
      (c) => c.category === 'config_file' && c.target.startsWith(root),
    );
    expect(configConflicts.length).toBeGreaterThanOrEqual(3);

    const competitors = configConflicts.map((c) => c.competitor);
    expect(competitors).toContain('jcodemunch-mcp');
    expect(competitors).toContain('aider');
    expect(competitors).toContain('repomix');
  });

  // --- Project config directories ---

  it('detects competing project directories', () => {
    const root = fixture({
      '.cline/.gitkeep': '',
      '.aider.tags.cache.v3/.gitkeep': '',
    });

    const report = detectConflicts(root);
    const dirConflicts = report.conflicts.filter(
      (c) =>
        c.category === 'config_file' &&
        c.target.startsWith(root) &&
        c.summary.includes('directory'),
    );
    expect(dirConflicts.length).toBeGreaterThanOrEqual(2);
  });

  // --- CLAUDE.md injections ---

  it('detects competing CLAUDE.md with marker blocks', () => {
    const root = fixture({
      'CLAUDE.md':
        '# Project\n\n<!-- jcodemunch:start -->\nUse jcodemunch tools\n<!-- jcodemunch:end -->',
    });

    const report = detectConflicts(root);
    const claudeConflicts = report.conflicts.filter(
      (c) => c.category === 'claude_md' && c.target.startsWith(root),
    );
    expect(claudeConflicts.length).toBeGreaterThanOrEqual(1);

    const jcm = claudeConflicts.find((c) => c.competitor === 'jcodemunch-mcp');
    expect(jcm).toBeDefined();
    expect(jcm!.severity).toBe('critical');
    expect(jcm!.fixable).toBe(true);
  });

  it('detects competing CLAUDE.md with tool name references', () => {
    const root = fixture({
      'CLAUDE.md': '# Project\n\nAlways use get_file_outline from jcodemunch for file exploration.',
    });

    const report = detectConflicts(root);
    const claudeConflicts = report.conflicts.filter(
      (c) => c.category === 'claude_md' && c.target.startsWith(root),
    );
    expect(claudeConflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag clean CLAUDE.md', () => {
    const root = fixture({
      'CLAUDE.md': '# Project\n\nUse trace-mcp tools for code navigation.\n',
    });

    const report = detectConflicts(root);
    const claudeConflicts = report.conflicts.filter(
      (c) => c.category === 'claude_md' && c.target.startsWith(root),
    );
    expect(claudeConflicts).toHaveLength(0);
  });

  // --- IDE rule files ---

  it('detects competing IDE rule files', () => {
    const root = fixture({
      '.cursorrules': 'Always use jcodemunch for code navigation.',
      '.clinerules': 'Use cline for file operations.',
    });

    const report = detectConflicts(root);
    const ideConflicts = report.conflicts.filter(
      (c) => c.category === 'ide_rules' && c.target.startsWith(root),
    );
    expect(ideConflicts.length).toBeGreaterThanOrEqual(1);

    const jcm = ideConflicts.find((c) => c.competitor === 'jcodemunch-mcp');
    expect(jcm).toBeDefined();
  });

  it('does not flag IDE rule files without competing content', () => {
    const root = fixture({
      '.cursorrules': 'Use trace-mcp for all code intelligence tasks.',
    });

    const report = detectConflicts(root);
    const ideConflicts = report.conflicts.filter(
      (c) => c.category === 'ide_rules' && c.target.startsWith(root),
    );
    expect(ideConflicts).toHaveLength(0);
  });

  // --- Git hooks ---

  it('detects aider git hooks', () => {
    const root = fixture({
      '.git/hooks/pre-commit': '#!/bin/bash\naider --lint\n',
    });

    const report = detectConflicts(root);
    const hookConflicts = report.conflicts.filter(
      (c) => c.competitor === 'aider' && c.target.startsWith(root),
    );
    expect(hookConflicts.length).toBeGreaterThanOrEqual(1);
  });

  // --- No conflicts ---

  it('returns empty conflicts for clean project', () => {
    const root = fixture({
      'src/index.ts': 'console.log("hello")',
      'package.json': '{"name":"clean"}',
    });

    const report = detectConflicts(root);
    // Filter to only project-scoped conflicts
    const projectConflicts = report.conflicts.filter((c) => c.target.startsWith(root));
    expect(projectConflicts).toHaveLength(0);
  });
});
