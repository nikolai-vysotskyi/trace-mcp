/**
 * SearchTextRetriever ↔ direct-call equivalence tests.
 *
 * Migration slice 2 of the search-tool migration arc. Behaviour-preserving
 * refactor — calling the new retriever returns the same envelope as calling
 * `searchText()` directly. Every flag the tool advertises gets at least one
 * case here so silent behavioural drift is caught at CI.
 *
 * Coverage matrix:
 *   1. literal query → ok, matches found
 *   2. literal query with `language` filter
 *   3. literal query with `file_pattern` glob filter
 *   4. case_sensitive=true filters out a case-insensitive match
 *   5. is_regex=true honours regex syntax
 *   6. empty result set on a query nothing matches
 *   7. invalid regex propagates the error envelope (Result.Err)
 *   8. retriever exposes a stable `name` for telemetry/registry
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { searchText } from '../../tools/navigation/search-text.js';
import {
  createSearchTextRetriever,
  type SearchTextQuery,
} from '../retrievers/search-text-retriever.js';
import { runRetriever } from '../types.js';

interface Fixture {
  store: Store;
  projectRoot: string;
}

function seedFixture(): Fixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-search-text-'));
  const tsPath = path.join(projectRoot, 'src/sample.ts');
  const pyPath = path.join(projectRoot, 'src/util.py');
  fs.mkdirSync(path.dirname(tsPath), { recursive: true });
  fs.writeFileSync(
    tsPath,
    [
      'function loadConfig() {',
      "  return { mode: 'production' };",
      '}',
      '// TODO: support YAML',
      "const Banner = 'Hello, World';",
    ].join('\n'),
  );
  fs.writeFileSync(
    pyPath,
    ['def load_config():', "    return {'mode': 'production'}", '# TODO: support YAML'].join('\n'),
  );

  const store = new Store(initializeDatabase(':memory:'));
  store.insertFile('src/sample.ts', 'typescript', 'h1', fs.statSync(tsPath).size);
  store.insertFile('src/util.py', 'python', 'h2', fs.statSync(pyPath).size);
  return { store, projectRoot };
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
}

async function runViaRetriever(fixture: Fixture, q: SearchTextQuery): Promise<unknown> {
  const retriever = createSearchTextRetriever({
    store: fixture.store,
    projectRoot: fixture.projectRoot,
  });
  const [out] = await runRetriever(retriever, q);
  return out;
}

describe('SearchTextRetriever ↔ direct-call equivalence', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = seedFixture();
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('case 1: literal query — same matches as direct call', async () => {
    const direct = searchText(fixture.store, fixture.projectRoot, { query: 'loadConfig' });
    const via = await runViaRetriever(fixture, { query: 'loadConfig' });
    expect(via).toEqual(direct);
    // Sanity: the TS file matches.
    if (direct.isOk()) {
      expect(direct.value.matches.length).toBeGreaterThan(0);
    }
  });

  it('case 2: language filter (python only)', async () => {
    const direct = searchText(fixture.store, fixture.projectRoot, {
      query: 'load',
      language: 'python',
    });
    const via = await runViaRetriever(fixture, { query: 'load', language: 'python' });
    expect(via).toEqual(direct);
    if (direct.isOk()) {
      for (const m of direct.value.matches) expect(m.language).toBe('python');
    }
  });

  it('case 3: file_pattern glob', async () => {
    const direct = searchText(fixture.store, fixture.projectRoot, {
      query: 'TODO',
      filePattern: 'src/util.py',
    });
    const via = await runViaRetriever(fixture, { query: 'TODO', filePattern: 'src/util.py' });
    expect(via).toEqual(direct);
  });

  it('case 4: case_sensitive=true changes match set', async () => {
    const direct = searchText(fixture.store, fixture.projectRoot, {
      query: 'banner',
      caseSensitive: true,
    });
    const via = await runViaRetriever(fixture, { query: 'banner', caseSensitive: true });
    expect(via).toEqual(direct);
    if (direct.isOk()) {
      // Lowercase 'banner' must NOT match capitalised 'Banner' when case sensitive.
      expect(direct.value.matches).toEqual([]);
    }
  });

  it('case 5: regex query', async () => {
    const direct = searchText(fixture.store, fixture.projectRoot, {
      query: 'load[A-Z]\\w+',
      isRegex: true,
    });
    const via = await runViaRetriever(fixture, { query: 'load[A-Z]\\w+', isRegex: true });
    expect(via).toEqual(direct);
  });

  it('case 6: empty result set', async () => {
    const direct = searchText(fixture.store, fixture.projectRoot, {
      query: 'this-string-does-not-exist-anywhere',
    });
    const via = await runViaRetriever(fixture, { query: 'this-string-does-not-exist-anywhere' });
    expect(via).toEqual(direct);
    if (direct.isOk()) {
      expect(direct.value.matches).toEqual([]);
    }
  });

  it('case 7: invalid regex propagates Result.Err', async () => {
    const direct = searchText(fixture.store, fixture.projectRoot, {
      query: '[unclosed',
      isRegex: true,
    });
    const via = await runViaRetriever(fixture, { query: '[unclosed', isRegex: true });
    expect(via).toEqual(direct);
    expect(direct.isErr()).toBe(true);
  });

  it('exposes name "search_text_tool" for registry routing', () => {
    const retriever = createSearchTextRetriever({
      store: fixture.store,
      projectRoot: fixture.projectRoot,
    });
    expect(retriever.name).toBe('search_text_tool');
  });
});
