import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectConflicts } from '../../src/init/conflict-detector.js';
import { commentOutJsonKey, fixConflict } from '../../src/init/conflict-resolver.js';

describe('commentOutJsonKey', () => {
  it('comments out a multi-line server entry', () => {
    const input = `{
  "mcpServers": {
    "trace-mcp": {
      "command": "trace-mcp",
      "args": ["serve"]
    },
    "jcodemunch": {
      "command": "npx",
      "args": ["-y", "jcodemunch-mcp"]
    },
    "other": {
      "command": "other"
    }
  }
}`;
    const result = commentOutJsonKey(input, 'jcodemunch')!;
    expect(result).not.toBeNull();
    // jcodemunch lines should be commented
    expect(result).toContain('//     "jcodemunch": {');
    expect(result).toContain('//       "command": "npx"');
    expect(result).toContain('//       "args": ["-y", "jcodemunch-mcp"]');
    // trace-mcp and other should remain intact
    expect(result).toContain('    "trace-mcp": {');
    expect(result).toContain('    "other": {');
  });

  it('comments out a single-line entry', () => {
    const input = `{
  "mcpServers": {
    "trace-mcp": { "command": "trace-mcp" },
    "jcodemunch": { "command": "npx", "args": ["-y", "jcodemunch"] },
    "other": { "command": "other" }
  }
}`;
    const result = commentOutJsonKey(input, 'jcodemunch')!;
    expect(result).not.toBeNull();
    expect(result).toContain('//     "jcodemunch":');
    expect(result).toContain('    "trace-mcp":');
    expect(result).toContain('    "other":');
  });

  it('returns null when key is not found', () => {
    const input = `{ "mcpServers": { "trace-mcp": {} } }`;
    expect(commentOutJsonKey(input, 'jcodemunch')).toBeNull();
  });

  it('returns null when key is already commented out', () => {
    const input = `{
  "mcpServers": {
    "trace-mcp": {},
//     "jcodemunch": {
//       "command": "npx"
//     }
  }
}`;
    expect(commentOutJsonKey(input, 'jcodemunch')).toBeNull();
  });

  it('handles nested braces inside string values', () => {
    const input = `{
  "mcpServers": {
    "jcodemunch": {
      "command": "npx",
      "env": {
        "CONFIG": "{\\"key\\": \\"val\\"}"
      }
    }
  }
}`;
    const result = commentOutJsonKey(input, 'jcodemunch')!;
    expect(result).not.toBeNull();
    // All lines of jcodemunch should be commented
    const lines = result.split('\n');
    const commented = lines.filter((l) => l.trimStart().startsWith('//'));
    // "jcodemunch" key + "command" + "env" opening + "CONFIG" + env closing + jcodemunch closing = 6 lines
    expect(commented.length).toBe(6);
  });

  it('handles entry with array value', () => {
    const input = `{
  "mcpServers": {
    "jcodemunch": {
      "command": "npx",
      "args": [
        "-y",
        "jcodemunch-mcp"
      ]
    }
  }
}`;
    const result = commentOutJsonKey(input, 'jcodemunch')!;
    expect(result).not.toBeNull();
    // All jcodemunch lines should be commented
    expect(result).toContain('//     "jcodemunch"');
    expect(result).toContain('//     }');
    // No uncommented jcodemunch references
    const lines = result.split('\n');
    const uncommented = lines.filter(
      (l) => !l.trimStart().startsWith('//') && l.includes('jcodemunch'),
    );
    expect(uncommented).toHaveLength(0);
  });
});

describe('fixClaudeMdBlock — bare mention fallback (TRA-49)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-conflict-fix-'));
    tmpDirs.push(root);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, name), content);
    }
    return root;
  }

  it('is fixable and comments out a bare tool-reference line instead of requiring manual fix', () => {
    const root = fixture({
      'CLAUDE.md':
        '# Project\n\nAlways use get_file_outline from jcodemunch for file exploration.\n',
    });

    const conflict = detectConflicts(root).conflicts.find(
      (c) =>
        c.category === 'claude_md' &&
        c.competitor === 'jcodemunch-mcp' &&
        c.target.startsWith(root),
    )!;
    expect(conflict).toBeDefined();
    expect(conflict.fixable).toBe(true);

    const result = fixConflict(conflict);
    expect(result.action).toBe('cleaned');

    const updated = fs.readFileSync(conflict.target, 'utf-8');
    expect(updated).toContain('<!-- trace-mcp: disabled by doctor --fix');
    expect(updated).not.toMatch(/^Always use get_file_outline/m);
    // Unrelated content survives untouched.
    expect(updated).toContain('# Project');
  });

  it('leaves negated mentions alone even inside an otherwise-fixed file', () => {
    const root = fixture({
      'CLAUDE.md':
        '# Project\n\nUse get_file_outline from jcodemunch for exploration.\n' +
        'Never call jcodemunch tools for anything else; prefer trace-mcp.\n',
    });

    const conflict = detectConflicts(root).conflicts.find(
      (c) =>
        c.category === 'claude_md' &&
        c.competitor === 'jcodemunch-mcp' &&
        c.target.startsWith(root),
    )!;
    const result = fixConflict(conflict);
    expect(result.action).toBe('cleaned');

    const updated = fs.readFileSync(conflict.target, 'utf-8');
    expect(updated).toContain('Never call jcodemunch tools for anything else');
    expect(updated).not.toMatch(/^Use get_file_outline/m);
  });

  it('dry-run reports the fix without touching the file', () => {
    const root = fixture({
      'CLAUDE.md': '# Project\n\nAlways use get_file_outline from jcodemunch.\n',
    });

    const conflict = detectConflicts(root).conflicts.find(
      (c) =>
        c.category === 'claude_md' &&
        c.competitor === 'jcodemunch-mcp' &&
        c.target.startsWith(root),
    )!;
    const original = fs.readFileSync(conflict.target, 'utf-8');

    const result = fixConflict(conflict, { dryRun: true });
    expect(result.action).toBe('cleaned');
    expect(fs.readFileSync(conflict.target, 'utf-8')).toBe(original);
  });
});
