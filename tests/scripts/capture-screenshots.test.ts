import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  checkFreshness,
  checkWindowChrome,
  CHROME_STRIP,
  decodePng,
  IDLE_REQUIRED_S,
  IMAGES_DIR,
  MANIFEST_PATH,
  mayStartCapture,
  parseIdleSeconds,
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

describe('the idle gate', () => {
  const IOREG = '    | | |   "HIDIdleTime" = 421000000000\n    | | |   "HIDBuild" = "x"';

  it('reads the idle time out of ioreg, in seconds', () => {
    expect(parseIdleSeconds(IOREG)).toBe(421);
  });

  it('has no idle time to report when ioreg says nothing about HID', () => {
    expect(parseIdleSeconds('+-o Root  <class IORegistryEntry>')).toBeNull();
    expect(parseIdleSeconds(undefined)).toBeNull();
  });

  it('lets a capture start on a machine nobody has touched', () => {
    expect(mayStartCapture(IDLE_REQUIRED_S + 1)).toEqual({ ok: true, reason: null });
  });

  it('defers while somebody is using the machine', () => {
    const verdict = mayStartCapture(12);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('12s ago');
  });

  it('defers when it cannot tell — not knowing is not permission', () => {
    expect(mayStartCapture(null).ok).toBe(false);
  });

  it('goes ahead anyway when a human asked for it', () => {
    expect(mayStartCapture(0, { force: true }).ok).toBe(true);
    expect(mayStartCapture(null, { force: true }).ok).toBe(true);
  });
});

/* TRA-403: three agents drive this app and a browser on a machine somebody is
   working on. macOS follows an app activation to that app's Space, so every
   show/focus call in a harness path is a chance to yank the user out of their
   full-screen app — and each of the ones below was one until it was removed. */
describe('no harness path steals the screen', () => {
  const SCREEN_API = /\.show\(\)|\.showInactive\(|\.focus\(|\.moveTop\(|shell\.openExternal/;

  /** Source lines that call one, ignoring comments and doc blocks. */
  function screenCalls(source: string) {
    return source
      .split('\n')
      .map((text, index) => ({ line: index + 1, text: text.trim() }))
      .filter(
        ({ text }) => SCREEN_API.test(text) && !text.startsWith('*') && !text.startsWith('//'),
      );
  }

  /** The line range of a function, from its header to the closing brace. */
  function bodyOf(source: string, header: string) {
    const lines = source.split('\n');
    const start = lines.findIndex((l) => l.startsWith(header));
    expect(start, `${header} — did it get renamed?`).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return { start: start + 1, end: end + 1 };
  }

  it('the review harness shows nothing at all', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/app/scripts/electron-cdp.mjs'),
      'utf-8',
    );
    expect(screenCalls(source)).toEqual([]);
  });

  it('the publication capture takes the front in one place only', () => {
    const file = path.join(REPO_ROOT, 'scripts/capture-screenshots.mjs');
    const source = fs.readFileSync(file, 'utf-8');
    // It cannot avoid taking it: AppKit draws the traffic lights of a window
    // whose app is not active in grey, and `checkWindowChrome` refuses those.
    const allowed = [
      bodyOf(source, 'async function sizeWindow'),
      bodyOf(source, 'async function frontWindowId'),
    ];
    for (const call of screenCalls(source)) {
      expect(
        allowed.some((r) => call.line >= r.start && call.line <= r.end),
        `capture-screenshots.mjs:${call.line} — ${call.text}`,
      ).toBe(true);
    }
  });

  it('the app shows a window in one place, and that place can be told not to', () => {
    const file = path.join(REPO_ROOT, 'packages/app/src/main/tray.ts');
    const source = fs.readFileSync(file, 'utf-8');
    const present = bodyOf(source, 'function presentWindow');
    expect(source).toContain('if (HIDDEN_WINDOWS) return;');
    // …and the Dock icon with it: `ensureDockVisible` is reached through
    // `presentWindow` and nowhere else, so a hidden run takes no Dock tile.
    expect(source.match(/ensureDockVisible\(\);/g)).toHaveLength(1);
    const dock = bodyOf(source, 'function ensureDockVisible');
    const allowed = [present, dock];
    for (const call of screenCalls(source)) {
      const sanctioned = allowed.some((r) => call.line >= r.start && call.line <= r.end);
      expect(
        sanctioned || call.text.includes('HIDDEN_WINDOWS'),
        `tray.ts:${call.line} — ${call.text} escapes the hidden-window check`,
      ).toBe(true);
    }
  });
});

/* A frame the size and shape of what `screencapture -l` returns: a window with
   transparent rounded corners and, at 2× in the top-left strip, the three
   macOS buttons in the colours a real capture measures. */
const SCALE = 2;
const FRAME = { width: 400, height: 240 };
/** close, minimise, zoom — measured off a real window capture. */
const LIGHT_RGB = [
  [236, 103, 101],
  [242, 202, 68],
  [44, 170, 47],
];

function windowFrame({ rounded = true, lights = [0, 1, 2] as number[] } = {}) {
  const { width, height } = FRAME;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set([30, 30, 30, 255], i * 4);
  }
  if (rounded) {
    // The corner radius, roughly: everything the check samples must be clear.
    const r = 6 * SCALE;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nearX = Math.min(x, width - 1 - x);
        const nearY = Math.min(y, height - 1 - y);
        if (nearX < r && nearY < r) rgba[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
  // 16×16 device px each — a third of a real 12pt button, which is the floor.
  for (const index of lights) {
    const [r, g, b] = LIGHT_RGB[index];
    const originX = 10 + index * 40;
    for (let y = 20; y < 36; y++) {
      for (let x = originX; x < originX + 16; x++) rgba.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

describe('checkWindowChrome', () => {
  it('accepts a window capture — alpha corners, three lit buttons', () => {
    expect(checkWindowChrome(windowFrame(), SCALE)).toEqual({ ok: true, reasons: [] });
  });

  it('rejects a capture of the web contents — square, fully opaque corners', () => {
    const result = checkWindowChrome(windowFrame({ rounded: false }), SCALE);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('no rounded window corners');
    expect(result.reasons.join(' ')).toContain('top-left');
  });

  it('rejects a window that was not frontmost — the buttons are grey', () => {
    const result = checkWindowChrome(windowFrame({ lights: [] }), SCALE);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('no traffic lights');
  });

  it('names which button is missing', () => {
    const result = checkWindowChrome(windowFrame({ lights: [0, 2] }), SCALE);
    expect(result.reasons.join(' ')).toContain('minimise (yellow)');
    expect(result.reasons.join(' ')).not.toContain('close (red)');
  });

  it('only looks where the buttons are', () => {
    // The same colours further into the window are content, not chrome.
    const frame = windowFrame({ lights: [] });
    for (const [index, [r, g, b]] of LIGHT_RGB.entries()) {
      const originX = CHROME_STRIP.width * SCALE + 10 + index * 40;
      for (let y = 20; y < 36; y++) {
        for (let x = originX; x < originX + 16; x++) {
          frame.rgba.set([r, g, b, 255], (y * frame.width + x) * 4);
        }
      }
    }
    expect(checkWindowChrome(frame, SCALE).ok).toBe(false);
  });
});

describe('decodePng', () => {
  /** PNG with one row per filter type, so the unfilter path is exercised. */
  function encodePng({ width, height, rgba }: ReturnType<typeof windowFrame>) {
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const line = rgba.subarray(y * stride, (y + 1) * stride);
      const filter = y % 5;
      raw[y * (stride + 1)] = filter;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? line[x - 4] : 0;
        const b = prev[x];
        const c = x >= 4 ? prev[x - 4] : 0;
        let out = line[x];
        if (filter === 1) out -= a;
        else if (filter === 2) out -= b;
        else if (filter === 3) out -= (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
          out -= pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        raw[y * (stride + 1) + 1 + x] = out & 255;
      }
      prev = line;
    }
    const chunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, 'ascii');
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
      return Buffer.concat([head, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  it('round-trips every scanline filter', () => {
    const frame = windowFrame();
    const decoded = decodePng(encodePng(frame));
    expect(decoded.width).toBe(frame.width);
    expect(decoded.height).toBe(frame.height);
    expect(Buffer.from(decoded.rgba)).toEqual(Buffer.from(frame.rgba));
  });

  it('passes a decoded window capture through the chrome check', () => {
    expect(checkWindowChrome(decodePng(encodePng(windowFrame())), SCALE).ok).toBe(true);
  });

  it('refuses something that is not a PNG', () => {
    expect(() => decodePng(Buffer.from('not an image'))).toThrow(/not a PNG/);
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
