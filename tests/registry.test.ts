import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGlobalDirs, REGISTRY_PATH } from '../src/global.js';
import { registerProject, resolveRegisteredAncestor } from '../src/registry.js';

let savedRegistry: string | null = null;

beforeEach(() => {
  ensureGlobalDirs();
  savedRegistry = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, 'utf8') : null;
  // Start with empty registry for each test.
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, projects: {} }, null, 2));
});

afterEach(() => {
  if (savedRegistry !== null) {
    fs.writeFileSync(REGISTRY_PATH, savedRegistry);
  } else {
    fs.rmSync(REGISTRY_PATH, { force: true });
  }
});

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-resolve-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

describe('resolveRegisteredAncestor', () => {
  it('returns null when no registered project covers the path', () => {
    const dir = makeTmpRepo();
    expect(resolveRegisteredAncestor(dir)).toBeNull();
  });

  it('returns self when the path is registered directly', () => {
    const repo = makeTmpRepo();
    registerProject(repo);
    const entry = resolveRegisteredAncestor(repo);
    expect(entry?.root).toBe(repo);
  });

  it('returns the registered ancestor for a nested subdirectory', () => {
    const repo = makeTmpRepo();
    registerProject(repo);
    const nested = path.join(repo, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');

    const entry = resolveRegisteredAncestor(nested);
    expect(entry?.root).toBe(repo);
  });

  it('prefers an exact registered match over an ancestor', () => {
    const repo = makeTmpRepo();
    const nested = path.join(repo, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    registerProject(repo);
    registerProject(nested);

    const entry = resolveRegisteredAncestor(nested);
    expect(entry?.root).toBe(nested);
  });

  it('matches a multi-root parent that lists the path as a child', () => {
    const parent = makeTmpRepo();
    const child = path.join(parent, 'svc-a');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'package.json'), '{}');
    registerProject(parent, { type: 'multi-root', children: [child] });

    const entry = resolveRegisteredAncestor(child);
    expect(entry?.root).toBe(parent);
  });
});
