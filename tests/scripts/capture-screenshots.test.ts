import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkFreshness,
  IMAGES_DIR,
  MANIFEST_PATH,
  readMarker,
  REPO_ROOT,
} from '../../scripts/capture-screenshots.mjs';

const marker = {
  appVersion: '3.1.1',
  uiCommit: 'a'.repeat(40),
  images: [{ file: 'app-graph.webp' }],
};
const current = { appVersion: '3.1.1', uiCommit: 'a'.repeat(40), presentFiles: ['app-graph.webp'] };

describe('checkFreshness', () => {
  it('is fresh when the app, the version and the files all match the marker', () => {
    expect(checkFreshness(marker, current)).toEqual({ fresh: true, reasons: [] });
  });

  it('is stale when the renderer changed after the capture', () => {
    const result = checkFreshness(marker, { ...current, uiCommit: 'b'.repeat(40) });
    expect(result.fresh).toBe(false);
    expect(result.reasons[0]).toContain('app UI changed');
  });

  it('is stale when the app version moved', () => {
    const result = checkFreshness(marker, { ...current, appVersion: '3.2.0' });
    expect(result.fresh).toBe(false);
    expect(result.reasons.join(' ')).toContain('3.1.1 → 3.2.0');
  });

  it('is stale when a promised image is not on disk', () => {
    const result = checkFreshness(marker, { ...current, presentFiles: [] });
    expect(result.fresh).toBe(false);
    expect(result.reasons.join(' ')).toContain('app-graph.webp');
  });

  it('is stale — not fresh-by-default — when no capture has ever run', () => {
    expect(checkFreshness(null, current).fresh).toBe(false);
  });
});

describe('the committed screenshots', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

  it('has one image per manifest entry, and the marker points at real files', () => {
    const committed = readMarker();
    expect(committed).not.toBeNull();
    expect(committed?.images.map((i) => i.name).sort()).toEqual(
      manifest.shots.map((s: { name: string }) => s.name).sort(),
    );
    for (const image of committed?.images ?? []) {
      expect(fs.existsSync(path.join(IMAGES_DIR, image.file))).toBe(true);
    }
  });

  it('keeps the alt text in README and the landing page equal to the manifest', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');
    const landing = fs.readFileSync(path.join(REPO_ROOT, 'docs/index.html'), 'utf-8');
    for (const shot of manifest.shots as { name: string; alt: string }[]) {
      expect(readme, `README alt for ${shot.name}`).toContain(`alt="${shot.alt}"`);
      expect(landing, `index.html alt for ${shot.name}`).toContain(`alt="${shot.alt}"`);
    }
  });

  it('stays small enough for the landing page', () => {
    const total = (readMarker()?.images ?? []).reduce((sum, i) => sum + i.bytes, 0);
    // The four PNGs this replaced were 6.0 MB between them.
    expect(total).toBeLessThan(1_500_000);
  });
});
