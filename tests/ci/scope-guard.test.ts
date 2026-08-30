import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

// TRA-528: #659 was written in a stale worktree, then committed with master's
// tip as its parent. Every content-blind gate passed — the branch was up to
// date by definition — while the squashed tree reverted 40+ files, a workflow
// and the 3.6.0 release manifest. These two steps look at the content instead,
// so they are the thing that has to keep working. The scripts under test are
// read out of ci.yml itself: a threshold edited there and not here fails loudly.

const REPO = path.resolve(__dirname, '../..');

function guardStep(name: string): string {
  const wf = yaml.parse(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  const step = wf.jobs['scope-guard'].steps.find((s: { name?: string }) => s.name === name);
  if (!step?.run) throw new Error(`scope-guard has no step named "${name}"`);
  return step.run;
}

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '--quiet', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

/** Runs a guard script the way the workflow does. Returns the exit code. */
function run(script: string, env: Record<string, string>): number {
  try {
    execFileSync('bash', ['-c', script], {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-guard-'));
  git('init', '--quiet', '-b', 'master');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('the version never goes backwards', () => {
  const script = guardStep('The version never goes backwards');

  function base(version: string): string {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version }));
    return commit('base');
  }

  it('fails when a stale base rolls the release manifest back', () => {
    const BASE = base('3.6.0');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '3.3.0' }));
    commit('stale tree');
    expect(run(script, { BASE })).not.toBe(0);
  });

  it('passes an unchanged version and a forward bump', () => {
    const BASE = base('3.6.0');
    expect(run(script, { BASE })).toBe(0);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '3.10.0' }));
    commit('release');
    expect(run(script, { BASE })).toBe(0);
  });
});

describe('a PR does not silently rewrite the repo', () => {
  const script = guardStep('A PR does not silently rewrite the repo');

  /** Writes `n` files of `lines` lines each. */
  function tree(n: number, lines: number): void {
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), `${'x\n'.repeat(lines)}`);
    }
  }

  it('fails a PR that deletes the repo out from under itself', () => {
    tree(200, 60);
    const BASE = commit('base');
    for (let i = 0; i < 200; i++) fs.rmSync(path.join(repo, `f${i}.txt`));
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'one small change\n');
    commit('stale tree');
    expect(run(script, { BASE, LABELS: '' })).not.toBe(0);
  });

  it('lets that same PR through when it is labelled deliberate', () => {
    tree(200, 60);
    const BASE = commit('base');
    for (let i = 0; i < 200; i++) fs.rmSync(path.join(repo, `f${i}.txt`));
    commit('deliberate purge');
    expect(run(script, { BASE, LABELS: 'dependencies,large-diff' })).toBe(0);
  });

  it('passes an ordinary PR', () => {
    tree(200, 60);
    const BASE = commit('base');
    fs.writeFileSync(path.join(repo, 'f0.txt'), 'edited\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'added\n');
    commit('ordinary');
    expect(run(script, { BASE, LABELS: '' })).toBe(0);
  });
});
