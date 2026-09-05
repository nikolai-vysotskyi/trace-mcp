import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NO_BASELINE_TOOLS } from '../../../savings.js';
import { captureAllTools } from './_capture-tools.js';

/**
 * Every `server.tool('name', ...)` in the register modules, read from source.
 * The capture harness misses tools registered behind a runtime condition
 * (`subproject_*`), and those are exactly the mutating ones this set is about.
 */
function registeredNamesFromSource(): Set<string> {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== '__tests__') walk(join(d, e.name));
      else if (e.isFile() && e.name.endsWith('.ts')) files.push(join(d, e.name));
    }
  };
  walk(dir);
  const names = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf-8').matchAll(
      /(?:server\.tool|_originalTool)\(\s*\n?\s*'([a-z_0-9]+)'/g,
    ))
      names.add(m[1]);
  }
  return names;
}

/**
 * TRA-945: a savings figure is "what a Read/Grep would have cost minus what we
 * returned". A tool that mutates something has no left-hand side to that
 * subtraction — no file read reindexes a project or renames a symbol — so
 * crediting it `DEFAULT_RAW_COST` invents savings. On the measurement machine
 * that was 1 731 calls booking ~736k tokens that were never saved.
 *
 * The two directions below are the whole guard: a new mutating tool cannot be
 * added without deciding whether it books savings, and the set cannot rot into
 * names that no longer exist.
 */
describe('no-baseline tools (TRA-945)', () => {
  const captured = captureAllTools();
  const names = registeredNamesFromSource();

  it('names only tools that are actually registered', () => {
    const stale = [...NO_BASELINE_TOOLS].filter((t) => !names.has(t));
    expect(
      stale,
      `NO_BASELINE_TOOLS lists tools that no longer exist: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('covers every tool that says it mutates', () => {
    const mutating = captured
      .filter((t) => /\bMutates\b/.test(t.description))
      .map((t) => t.name)
      .filter((n) => !NO_BASELINE_TOOLS.has(n));
    expect(
      mutating,
      'These tools describe themselves as mutating but would still book token savings ' +
        `against a Read/Grep that could not have done the same thing: ${mutating.join(', ')}. ` +
        'Add them to NO_BASELINE_TOOLS in src/savings.ts, or reword the description.',
    ).toEqual([]);
  });
});
