import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { guessFirstProject } from '../project-guess';

describe('guessFirstProject', () => {
  const tempHome = path.join(os.tmpdir(), `trace-test-home-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns null if no project directories exist', () => {
    const result = guessFirstProject(tempHome);
    expect(result).toBeNull();
  });

  it('finds project in ~/Projects containing package.json', () => {
    const projDir = path.join(tempHome, 'Projects', 'cool-app');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'package.json'), '{}');

    const result = guessFirstProject(tempHome);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('cool-app');
    expect(result?.path).toBe(projDir);
  });

  it('picks the most recently modified project directory', () => {
    const proj1 = path.join(tempHome, 'Projects', 'old-app');
    fs.mkdirSync(proj1, { recursive: true });
    fs.writeFileSync(path.join(proj1, 'package.json'), '{}');

    const proj2 = path.join(tempHome, 'Developer', 'new-app');
    fs.mkdirSync(proj2, { recursive: true });
    fs.writeFileSync(path.join(proj2, 'Cargo.toml'), '[package]');

    const now = Date.now() / 1000;
    fs.utimesSync(proj1, now - 100, now - 100);
    fs.utimesSync(proj2, now, now);

    const result = guessFirstProject(tempHome);
    expect(result?.name).toBe('new-app');
    expect(result?.path).toBe(proj2);
  });
});
