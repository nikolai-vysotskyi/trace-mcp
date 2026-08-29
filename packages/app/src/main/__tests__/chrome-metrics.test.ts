import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOP_BAND_H,
  TRAFFIC_LIGHT_D,
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  trafficLightCentreY,
} from '../../shared/chrome-metrics.js';

/* TRA-370. Nikolai reported the sidebar toggle sitting off the traffic-light
   centre line. It was arithmetic, not taste: `trafficLightPosition.y = 18` and
   `height: 44px` were picked independently in two files, and nothing tied them
   together. This test is the tie. */
describe('traffic lights sit on the top band centre line', () => {
  it('derives the offset from the band height', () => {
    expect(trafficLightCentreY()).toBe(TOP_BAND_H / 2);
    expect(TRAFFIC_LIGHT_Y).toBe((TOP_BAND_H - TRAFFIC_LIGHT_D) / 2 - 1);
  });

  it('reads the offset from the shared constant, never a literal', () => {
    // `src/main` builds to CommonJS, where `import.meta` is a compile error —
    // resolve from the vitest root instead, as install-path.test.ts does.
    const tray = readFileSync(path.resolve(process.cwd(), 'src/main/tray.ts'), 'utf8');
    expect(tray).toContain(
      'opts.trafficLightPosition = { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y };',
    );
    expect(tray).not.toMatch(/trafficLightPosition\s*=\s*\{\s*x:\s*\d/);
  });

  it('keeps the lights clear of the window edge', () => {
    expect(TRAFFIC_LIGHT_X).toBeGreaterThan(0);
    expect(TRAFFIC_LIGHT_Y).toBeGreaterThan(0);
  });
});
