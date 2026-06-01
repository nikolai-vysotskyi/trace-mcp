import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectServices } from '../../src/topology/service-detector.js';

/** Create a directory tree from a map of relative-path → file contents. */
function scaffold(root: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
}

describe('detectServices', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'service-detector-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('treats a Laravel app with nova-components as a SINGLE service (no phantom sub-services)', () => {
    // A Laravel app: composer.json at root, plus Nova local components and a
    // vendored package, each carrying their own composer.json. None of these
    // are deployable services.
    const app = path.join(tmp, 'my-laravel');
    scaffold(app, {
      'composer.json': '{"name":"acme/app"}',
      'nova-components/Faq/composer.json': '{"name":"acme/faq"}',
      'nova-components/Calendar/composer.json': '{"name":"acme/calendar"}',
      'nova-components/Ratings/composer.json': '{"name":"acme/ratings"}',
      'packages/yookassa-sdk/composer.json': '{"name":"acme/yookassa"}',
      'app/Models/User.php': '<?php',
      'routes/api.php': '<?php',
    });

    const services = detectServices([app]);
    expect(services).toHaveLength(1);
    expect(services[0].repoRoot).toBe(app);
    // No nova-components or packages sub-dir leaked in as a service.
    expect(services.some((s) => s.repoRoot.includes('nova-components'))).toBe(false);
    expect(services.some((s) => s.repoRoot.includes('/packages/'))).toBe(false);
  });

  it('still detects nested services in a real grouped container (no root marker)', () => {
    // Container with NO root marker holding group/service pairs — the legitimate
    // Pattern-2 case that must keep working.
    const container = path.join(tmp, 'monorepo');
    scaffold(container, {
      '15carats/15carats-front/package.json': '{"name":"front"}',
      '15carats/15carats-laravel/composer.json': '{"name":"back"}',
      'fair/fair-front/package.json': '{"name":"fair-front"}',
      'fair/fair-laravel/composer.json': '{"name":"fair-back"}',
    });

    const services = detectServices([container]);
    const roots = services.map((s) => path.relative(container, s.repoRoot)).sort();
    expect(roots).toContain('15carats/15carats-front');
    expect(roots).toContain('15carats/15carats-laravel');
    expect(roots).toContain('fair/fair-front');
    expect(roots).toContain('fair/fair-laravel');
  });

  it('detects a flat monorepo via direct children (Pattern 1)', () => {
    const flat = path.join(tmp, 'flat');
    scaffold(flat, {
      'frontend/package.json': '{"name":"fe"}',
      'backend/composer.json': '{"name":"be"}',
    });

    const services = detectServices([flat]);
    const names = services.map((s) => s.name).sort();
    expect(names).toEqual(['backend', 'frontend']);
  });
});
