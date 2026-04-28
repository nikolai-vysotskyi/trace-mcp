import { describe, expect, it } from 'vitest';
import { commentOutJsonKey } from '../../src/init/conflict-resolver.js';

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
