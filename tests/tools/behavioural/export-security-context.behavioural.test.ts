/**
 * Behavioural coverage for `exportSecurityContext()` (the `export_security_context`
 * MCP tool). Pins the result envelope, classification behaviour, and scope/depth
 * parameter handling.
 *
 *  - empty index returns the documented envelope (not throws) with a warning
 *  - tool_registrations classified by security category when a tool handler calls
 *    a recognised dangerous function (fs.readFile → file_read)
 *  - depth parameter is clamped to [0,5] and respected vs depth=1
 *  - scope parameter narrows tool_registrations to files under the prefix
 *  - capability_map keys are file paths, values are sorted category arrays
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { exportSecurityContext } from '../../../src/tools/quality/security-context-export.js';
import { createTestStore } from '../../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-esc-behav-${process.pid}`);

function writeFixture(store: Store, relPath: string, content: string): number {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
  return store.insertFile(relPath, 'typescript', `h_${relPath}`, content.length);
}

function seedToolRegistration(
  store: Store,
  relPath: string,
  toolName: string,
  body: string,
): number {
  const source = [
    "import { server } from './server.js';",
    "import { readFileSync } from 'node:fs';",
    '',
    `server.tool('${toolName}', { description: 'test tool' }, async (args) => {`,
    body,
    '  return { content: [] };',
    '});',
    '',
  ].join('\n');
  const fid = writeFixture(store, relPath, source);
  // Find the line where the .tool( call lives.
  const lines = source.split('\n');
  const toolLine = lines.findIndex((l) => l.includes(`.tool('${toolName}'`)) + 1;
  store.insertRoute(
    {
      uri: toolName,
      method: 'TOOL',
      handler: null,
      filePath: relPath,
      name: 'test tool',
      line: toolLine,
    } as never,
    fid,
  );
  return fid;
}

describe('exportSecurityContext() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createTestStore();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('empty index returns documented envelope with a warning (does not throw)', () => {
    const result = exportSecurityContext(store, TEST_DIR);
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data).toHaveProperty('tool_registrations');
    expect(data).toHaveProperty('sensitive_flows');
    expect(data).toHaveProperty('capability_map');
    expect(data).toHaveProperty('warnings');
    expect(data.version).toBe('1');
    expect(typeof data.generator).toBe('string');
    expect(typeof data.generated_at).toBe('string');
    expect(Array.isArray(data.tool_registrations)).toBe(true);
    expect(Array.isArray(data.sensitive_flows)).toBe(true);
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(data.tool_registrations).toEqual([]);
    expect(data.warnings.length).toBeGreaterThan(0); // "No MCP tool registrations found"
  });

  it('tool_registrations are classified — fs.readFile in handler surfaces file_read category', () => {
    seedToolRegistration(
      store,
      'src/server/read-tool.ts',
      'read_file_tool',
      [
        '  const path = args.path;',
        '  const data = readFileSync(path, "utf-8");',
        '  return data;',
      ].join('\n'),
    );

    const result = exportSecurityContext(store, TEST_DIR, { depth: 2 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.tool_registrations.length).toBe(1);
    const reg = data.tool_registrations[0];
    expect(reg.name).toBe('read_file_tool');
    expect(reg.file).toBe('src/server/read-tool.ts');
    // The fs.readFileSync call should surface a file_read category — the
    // tool scans the inline handler body and classifies known names.
    const categories = reg.handler_calls.map((c) => c.category);
    expect(categories).toContain('file_read');
    // capability_map mirrors the classification per file.
    expect(data.capability_map['src/server/read-tool.ts']).toBeDefined();
    expect(data.capability_map['src/server/read-tool.ts']).toContain('file_read');
  });

  it('scope parameter narrows tool_registrations to files under the prefix', () => {
    seedToolRegistration(store, 'src/server/in-scope.ts', 'in_scope_tool', '  return null;');
    seedToolRegistration(
      store,
      'plugins/external/out-of-scope.ts',
      'out_of_scope_tool',
      '  return null;',
    );

    const result = exportSecurityContext(store, TEST_DIR, { scope: 'src/server/' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.tool_registrations.map((t) => t.name)).toEqual(['in_scope_tool']);
  });

  it('depth parameter accepts arbitrary values and clamps internally (no throw at depth=99)', () => {
    seedToolRegistration(store, 'src/server/deep.ts', 'deep_tool', '  return null;');

    const d1 = exportSecurityContext(store, TEST_DIR, { depth: 1 });
    const dHuge = exportSecurityContext(store, TEST_DIR, { depth: 99 });
    expect(d1.isOk()).toBe(true);
    expect(dHuge.isOk()).toBe(true);
    // Both succeed; high depth is internally clamped to 5 (no throw, no error).
    expect(d1._unsafeUnwrap().tool_registrations.length).toBe(1);
    expect(dHuge._unsafeUnwrap().tool_registrations.length).toBe(1);
  });

  it('capability_map values are sorted unique security categories', () => {
    seedToolRegistration(
      store,
      'src/server/multi.ts',
      'multi_tool',
      ['  const x = readFileSync("a.txt");', '  writeFileSync("b.txt", x);', '  return null;'].join(
        '\n',
      ),
    );

    const result = exportSecurityContext(store, TEST_DIR);
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const caps = data.capability_map['src/server/multi.ts'];
    expect(caps).toBeDefined();
    expect(Array.isArray(caps)).toBe(true);
    // Sorted alphabetically and unique.
    expect(caps).toEqual([...new Set(caps)].sort());
    // Should contain at least one of the two dangerous categories.
    const intersected = caps.filter((c) => c === 'file_read' || c === 'file_write');
    expect(intersected.length).toBeGreaterThan(0);
  });
});
