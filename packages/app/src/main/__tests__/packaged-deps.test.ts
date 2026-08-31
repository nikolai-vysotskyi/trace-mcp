import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `electron-builder.yml` packages production `dependencies` into app.asar
 * (`node_modules/**` is listed there so the main process keeps electron-updater
 * on Windows). Anything Vite already bundles into dist/renderer therefore ships
 * twice if it is a production dependency — that is how react-i18next and its
 * @babel/runtime tree grew app.asar from 1.6 MB to 5.8 MB.
 *
 * The rule: a package belongs in `dependencies` only if the MAIN process imports
 * it at runtime. Renderer-only packages go in devDependencies.
 */
// vitest runs with packages/app as its root, as the other main-process tests assume.
const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));

const MAIN_RUNTIME_DEPS = [
  'electron-updater', // main process, Windows update path
  'i18next', // main process menu/tray/dialog strings (react-i18next is renderer-only)
];

describe('packaged production dependencies', () => {
  it('ships only what the main process needs at runtime', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([...MAIN_RUNTIME_DEPS].sort());
  });

  it('keeps react-i18next out of the shipped bundle', () => {
    // Renderer-only: Vite bundles it, and it drags @babel/runtime in with it.
    expect(pkg.dependencies?.['react-i18next']).toBeUndefined();
    expect(pkg.devDependencies?.['react-i18next']).toBeDefined();
  });

  it('exports autoUpdater on default namespace for dynamic import interop', async () => {
    const mod = await import('electron-updater');
    const hasAutoUpdater = 'autoUpdater' in (mod.default ?? mod) || 'autoUpdater' in mod;
    expect(hasAutoUpdater).toBe(true);
  });
});
