/**
 * Regression test for CWE-78 (command injection) in getChangeImpact's git-churn
 * calculation. `getFileChurn` used to build a shell command string via template
 * interpolation:
 *
 *   execSync(`git log --since="${since}" --oneline -- "${filePath}" | wc -l`, ...)
 *
 * `filePath` flows in from an MCP tool call (`get_change_impact { filePath }`),
 * so a value containing shell metacharacters (e.g. `"; rm -rf /; echo "`) would
 * have broken out of the quoted string and been interpreted by the shell. The
 * fix switches to `execFileSync('git', [...argv])` — no shell is spawned, so
 * argv elements (including filePath) are never re-parsed for metacharacters.
 *
 * Git is fully mocked (pattern mirrors get-git-churn.behavioural.test.ts) so
 * the test is deterministic and offline.
 */
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../../src/config.js';
import type { Store } from '../../../src/db/store.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { getChangeImpact } from '../../../src/tools/analysis/impact.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

/** Force isGitRepo(cwd) to succeed and any `git log ...` call to return a fixed count. */
function mockGitRepoWithChurn(logOutput: string): void {
  mockExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') return Buffer.from('true');
    if (argList[0] === 'log') return Buffer.from(logOutput);
    return Buffer.from('');
  });
}

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/vue3-composition');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

async function setup() {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config = makeConfig();
  const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
  await pipeline.indexAll();
  return store;
}

describe('getChangeImpact git churn — command injection hardening', () => {
  let store: Store;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = await setup();
  });

  it('never calls execSync for git churn (no shell string interpolation)', () => {
    mockGitRepoWithChurn('3\ncommitA\ncommitB\ncommitC');

    const result = getChangeImpact(
      store,
      { filePath: 'src/composables/useAuth.ts' },
      3,
      200,
      FIXTURE_DIR,
    );
    expect(result.isOk()).toBe(true);

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('passes filePath as a discrete execFileSync argv element, not shell-concatenated', () => {
    mockGitRepoWithChurn('1\ncommitA');
    // A filePath containing shell metacharacters — must never break out of argv.
    const maliciousLikePath = 'src/composables/useAuth.ts';

    getChangeImpact(store, { filePath: maliciousLikePath }, 3, 200, FIXTURE_DIR);

    const logCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return c[0] === 'git' && args[0] === 'log';
    });
    expect(logCall).toBeDefined();
    const [cmd, args] = logCall as [string, string[]];
    expect(cmd).toBe('git');
    // filePath must appear as its own argv element (ideally after a `--`
    // separator), never interpolated into a combined string.
    expect(args).toContain(maliciousLikePath);
    // No element should contain shell pipe/redirection syntax — proves we
    // aren't shelling out to `| wc -l` anymore.
    for (const a of args) {
      expect(a).not.toMatch(/[|;&`$]/);
    }
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
