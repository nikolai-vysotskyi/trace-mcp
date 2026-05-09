import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractEntities } from '../../src/topology/entity-extractor.js';
import { detectTopicTunnels } from '../../src/topology/topic-tunnels.js';

function initGitRepo(dir: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  execSync('git init -q', { cwd: dir, env });
  execSync('git config user.email "test@example.invalid"', { cwd: dir, env });
  execSync('git config user.name "Test Author"', { cwd: dir, env });
}

function commitAs(
  dir: string,
  filename: string,
  content: string,
  authorName: string,
  authorEmail: string,
): void {
  writeFileSync(join(dir, filename), content);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };
  execSync(`git add ${filename}`, { cwd: dir, env });
  execSync(`git commit -q -m "${authorName}: ${filename}"`, { cwd: dir, env });
}

describe('extractEntities', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-entities-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts the project name and dependencies from package.json', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'my-app',
        dependencies: { 'react-router': '^6.0.0', '@org/private': '^1.0.0' },
      }),
    );
    const entities = extractEntities(dir);
    const projects = entities.filter((e) => e.kind === 'project');
    const packages = entities.filter((e) => e.kind === 'package');
    expect(projects.map((e) => e.canonical)).toEqual(['my-app']);
    expect(packages.map((e) => e.canonical).sort()).toEqual(['@org/private', 'react-router']);
  });

  it('extracts module name from go.mod', () => {
    writeFileSync(join(dir, 'go.mod'), 'module github.com/example/svc\n\ngo 1.21\n');
    const e = extractEntities(dir);
    expect(e[0]).toMatchObject({ kind: 'project', canonical: 'github.com/example/svc' });
  });

  it('extracts project name from pyproject.toml + scans dependencies', () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      `[project]
name = "my-pkg"
dependencies = ["fastapi>=0.100", "pydantic"]
`,
    );
    const e = extractEntities(dir);
    expect(e.find((x) => x.kind === 'project')?.canonical).toBe('my-pkg');
    const pkgs = e.filter((x) => x.kind === 'package').map((x) => x.canonical);
    expect(pkgs).toContain('fastapi');
    expect(pkgs).toContain('pydantic');
  });

  it('filters bot authors from git shortlog', () => {
    initGitRepo(dir);
    commitAs(dir, 'a.txt', 'a', 'Real Person', 'real@example.invalid');
    commitAs(
      dir,
      'b.txt',
      'b',
      'dependabot[bot]',
      '49699333+dependabot[bot]@users.noreply.github.com',
    );
    commitAs(dir, 'c.txt', 'c', 'renovate[bot]', 'renovate@example.invalid');
    const e = extractEntities(dir);
    const people = e.filter((x) => x.kind === 'person');
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((p) => !p.canonical.includes('bot'))).toBe(true);
  });

  it('returns empty for a non-existent path', () => {
    expect(extractEntities('/no/such/dir/that/can/exist')).toEqual([]);
  });

  it('dedupes entities by (kind, canonical)', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { foo: '1', FOO: '2' } }),
    );
    const e = extractEntities(dir);
    expect(e.filter((x) => x.canonical === 'foo')).toHaveLength(1);
  });
});

describe('detectTopicTunnels', () => {
  let dirA: string;
  let dirB: string;
  let dirC: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'trace-tunnels-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'trace-tunnels-b-'));
    dirC = mkdtempSync(join(tmpdir(), 'trace-tunnels-c-'));
  });
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  });

  it('surfaces a tunnel between repos that share a same-author + a non-common dep', () => {
    writeFileSync(
      join(dirA, 'package.json'),
      JSON.stringify({ name: 'svc-auth', dependencies: { '@myorg/sso': '^2', typescript: '^5' } }),
    );
    writeFileSync(
      join(dirB, 'package.json'),
      JSON.stringify({
        name: 'svc-billing',
        dependencies: { '@myorg/sso': '^2', typescript: '^5' },
      }),
    );
    initGitRepo(dirA);
    initGitRepo(dirB);
    commitAs(dirA, 'a.txt', 'a', 'Alice', 'alice@example.invalid');
    commitAs(dirB, 'b.txt', 'b', 'Alice', 'alice@example.invalid');

    const tunnels = detectTopicTunnels([
      { name: 'svc-auth', repoRoot: dirA },
      { name: 'svc-billing', repoRoot: dirB },
    ]);
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0].project_a).toBe('svc-auth');
    expect(tunnels[0].project_b).toBe('svc-billing');
    const sharedKinds = tunnels[0].shared.map((s) => s.kind).sort();
    expect(sharedKinds).toEqual(['package', 'package', 'person']);
    // typescript is in COMMON_PACKAGES so it's down-weighted; @myorg/sso is full weight.
    expect(tunnels[0].weight).toBeGreaterThan(2);
  });

  it('downweights tunnels whose only overlap is in the COMMON_PACKAGES list', () => {
    writeFileSync(
      join(dirA, 'package.json'),
      JSON.stringify({ name: 'a', dependencies: { typescript: '^5', eslint: '^9' } }),
    );
    writeFileSync(
      join(dirB, 'package.json'),
      JSON.stringify({ name: 'b', dependencies: { typescript: '^5', eslint: '^9' } }),
    );
    const tunnels = detectTopicTunnels(
      [
        { name: 'a', repoRoot: dirA },
        { name: 'b', repoRoot: dirB },
      ],
      { minWeight: 1 },
    );
    // 2 common deps × 0.25 = 0.5 → below minWeight 1 → no tunnel.
    expect(tunnels).toEqual([]);
  });

  it('does not surface tunnels with zero overlap', () => {
    writeFileSync(
      join(dirA, 'package.json'),
      JSON.stringify({ name: 'a', dependencies: { x: '1' } }),
    );
    writeFileSync(
      join(dirB, 'package.json'),
      JSON.stringify({ name: 'b', dependencies: { y: '1' } }),
    );
    expect(
      detectTopicTunnels([
        { name: 'a', repoRoot: dirA },
        { name: 'b', repoRoot: dirB },
      ]),
    ).toEqual([]);
  });

  it('handles three repos and ranks tunnels by weight', () => {
    writeFileSync(
      join(dirA, 'package.json'),
      JSON.stringify({ name: 'a', dependencies: { '@org/shared': '1' } }),
    );
    writeFileSync(
      join(dirB, 'package.json'),
      JSON.stringify({ name: 'b', dependencies: { '@org/shared': '1' } }),
    );
    writeFileSync(
      join(dirC, 'package.json'),
      JSON.stringify({ name: 'c', dependencies: { '@org/shared': '1', '@org/extra': '1' } }),
    );
    const tunnels = detectTopicTunnels([
      { name: 'a', repoRoot: dirA },
      { name: 'b', repoRoot: dirB },
      { name: 'c', repoRoot: dirC },
    ]);
    // Three pairs: a-b, a-c, b-c — all share @org/shared; b-c additionally share @org/extra
    expect(tunnels.length).toBe(3);
    expect(tunnels[0].weight).toBeGreaterThanOrEqual(tunnels[2].weight);
  });
});
