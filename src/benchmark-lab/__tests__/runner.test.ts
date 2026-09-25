/**
 * The Lab runner against a hermetic index: a three-file project indexed into
 * a temp DB, a hand-written three-fixture battery. No registry, no daemon,
 * no network — the same run works on a fresh checkout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { IndexingPipeline } from '../../indexer/pipeline.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { runLab } from '../runner.js';

const PROJECT_FILES: Record<string, string> = {
  'src/alpha.ts': [
    'export function alphaWidget(name: string): string {',
    '  return `widget:${name}`;',
    '}',
    '',
    'export class AlphaService {',
    '  describe(): string {',
    '    return alphaWidget("service");',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/beta.ts': [
    "import { alphaWidget } from './alpha.js';",
    '',
    'export function betaHandler(input: string): string {',
    '  return alphaWidget(input).toUpperCase();',
    '}',
    '',
  ].join('\n'),
  'src/gamma.ts': ['export const gammaConfig = { retries: 3, label: "gamma" };', ''].join('\n'),
};

async function buildHarness(): Promise<{
  projectRoot: string;
  dbPath: string;
  fixturesDir: string;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-lab-run-'));
  const projectRoot = path.join(root, 'proj');
  for (const [rel, content] of Object.entries(PROJECT_FILES)) {
    const abs = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const configResult = await loadConfig(projectRoot);
  if (configResult.isErr()) throw new Error('loadConfig failed on the temp project');
  const dbPath = path.join(root, 'index.db');
  const db = initializeDatabase(dbPath);
  const pipeline = new IndexingPipeline(
    new Store(db),
    PluginRegistry.createWithDefaults(),
    configResult.value,
    projectRoot,
  );
  await pipeline.indexAll(false);
  db.close();

  const fixturesDir = path.join(root, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  const fixtures = [
    {
      id: 'lab-symbol',
      query: 'alphaWidget',
      kind: 'symbol',
      expected_ids: ['alphaWidget'],
      k: 5,
      min_recall_at_k: 1.0,
    },
    {
      id: 'lab-file',
      query: 'betaHandler',
      kind: 'file',
      expected_ids: ['src/beta.ts'],
      k: 5,
      min_recall_at_k: 1.0,
    },
    {
      id: 'lab-decision',
      query: 'retry policy',
      kind: 'decision',
      expected_ids: ['Gamma retry policy'],
      k: 5,
      min_recall_at_k: 1.0,
      decisions_seed: [
        {
          title: 'Gamma retry policy',
          content: 'Retry gamma calls three times.',
          type: 'tech_choice',
        },
        { title: 'Beta naming', content: 'Handlers end in Handler.', type: 'convention' },
      ],
    },
  ];
  for (const f of fixtures) {
    fs.writeFileSync(path.join(fixturesDir, `${f.id}.json`), JSON.stringify(f, null, 2));
  }
  return { projectRoot, dbPath, fixturesDir };
}

describe('lab runner', () => {
  it('measures every arm on every fixture with exact tokens and a stable battery hash', async () => {
    const { projectRoot, dbPath, fixturesDir } = await buildHarness();
    const run = await runLab({ projectRoot, dbPath, fixturesDir });

    expect(run.schema_version).toBe(1);
    expect(run.arms).toEqual(['file-reading', 'minimal', 'standard']);
    expect(run.results).toHaveLength(3);
    expect(run.battery.fixture_count).toBe(3);
    expect(run.battery.fixtures_sha).toMatch(/^[0-9a-f]{16}$/);
    expect(run.measured_build.version).toMatch(/^\d+\.\d+\.\d+/);

    for (const row of run.results) {
      for (const arm of run.arms) {
        const m = row.arms[arm];
        expect(m, `${row.fixture_id}/${arm} measured`).toBeDefined();
        expect(m!.tokens).toBeGreaterThanOrEqual(0);
        expect(m!.ms).toBeGreaterThanOrEqual(0);
        expect(typeof m!.success).toBe('boolean');
      }
    }

    // The control prices raw bytes: the symbol and file fixtures resolve to
    // real files on disk.
    const symbol = run.results.find((r) => r.fixture_id === 'lab-symbol');
    expect(symbol?.arms['file-reading']?.success).toBe(true);
    expect(symbol?.arms['file-reading']?.tokens).toBeGreaterThan(0);
    // Exact-name symbol search is the ranker guarantee the recall harness
    // itself relies on — the minimal arm must clear it here too.
    expect(symbol?.arms['minimal']?.success).toBe(true);

    const file = run.results.find((r) => r.fixture_id === 'lab-file');
    expect(file?.arms['file-reading']?.success).toBe(true);
    expect(file?.arms['minimal']?.success).toBe(true);
    expect(file?.arms['standard']?.success).toBe(true);

    const decision = run.results.find((r) => r.fixture_id === 'lab-decision');
    expect(decision?.arms['minimal']?.success).toBe(true);
    // The control re-reads the seed corpus: one expected title among two
    // seeds still covers the fixture.
    expect(decision?.arms['file-reading']?.success).toBe(true);

    // Comparability contract: same battery → same hash, distinct run ids.
    const again = await runLab({ projectRoot, dbPath, fixturesDir });
    expect(again.battery.fixtures_sha).toBe(run.battery.fixtures_sha);
    expect(again.run_id).not.toBe(run.run_id);

    expect(run.aggregates.map((a) => a.arm)).toEqual(['file-reading', 'minimal', 'standard']);
    for (const a of run.aggregates) {
      expect(a.fixtures).toBe(3);
      expect(a.cost_usd).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  it('fails honestly without an index instead of recording zeros', async () => {
    await expect(
      runLab({ projectRoot: '/tmp/does-not-exist', dbPath: '/tmp/does-not-exist.db' }),
    ).rejects.toThrow(/needs an indexed project/);
  });
});
