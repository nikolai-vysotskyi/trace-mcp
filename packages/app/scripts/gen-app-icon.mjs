// Builds the whole app-icon set from the two vector masters in assets/icon/.
//
// Why this exists: until now there was no vector source at all. Every size was
// the same bitmap resampled — `icon-16.png` was a 725-byte squeeze of a 512px
// drawing, not a 16px icon — and the artwork lived inside generate-icons.mjs as
// a string of numbers nobody could open in an editor. TRA-780 measured what that
// costs: of the 48 objects in the old drawing, 36 were invisible at every size a
// dock or a sidebar ever uses, and the edges that make the mark a *graph* came
// out at 0.23px on a 32px icon.
//
// So: the drawing is now two real SVGs, and this script rasterises them.
//
//   node scripts/gen-app-icon.mjs [--out <dir>]
//
// Two masters, because .icns and .ico exist precisely to carry different
// drawings at different sizes:
//
//   assets/icon/icon.svg        >= 64px — the full fan, at its own proportions
//   assets/icon/icon-small.svg  <= 48px — the same nine nodes, edges and nodes
//                                 lifted over the pixel floor so they survive
//                                 the grid
//
// The node count is the same in both on purpose. A third master that dropped
// two leaves read sharper at 16px, and was rejected: at that size the mark is
// recognised as a silhouette, and a silhouette that differs from the one at
// every other size is a different icon.
//
// Each PNG is rendered by librsvg at its final size — the SVG's width/height are
// rewritten per target — so nothing is ever downsampled from a larger raster.
//
// This is the shipping artwork: release.yml calls this script, and
// generate-icons.mjs — which used to hold the drawing as a list of numbers — is
// gone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(APP_ROOT, 'assets', 'icon');

const argOut = process.argv.indexOf('--out');
const OUT_DIR = argOut === -1 ? path.join(APP_ROOT, 'build') : path.resolve(process.argv[argOut + 1]);

// Below this the small master is used. 48 is where a 1.1%-of-plate edge drops
// under half a pixel; see the measurements in TRA-780.
const SMALL_TIER_MAX = 48;

const masters = {
  detail: fs.readFileSync(path.join(ICON_DIR, 'icon.svg'), 'utf8'),
  small: fs.readFileSync(path.join(ICON_DIR, 'icon-small.svg'), 'utf8'),
};

function masterFor(size) {
  return size <= SMALL_TIER_MAX ? 'small' : 'detail';
}

/** Render the right master at `size`, natively — never a resize of a bigger one. */
function render(size) {
  const src = masters[masterFor(size)];
  const scaled = src.replace(
    /width="\d+" height="\d+"/,
    `width="${size}" height="${size}"`,
  );
  return sharp(Buffer.from(scaled)).png({ compressionLevel: 9 }).toBuffer();
}

// ── .icns ───────────────────────────────────────────────────────────────────
// An icns file is a header plus typed chunks, each carrying a PNG. Writing it
// here rather than shelling out to iconutil keeps the build working off macOS.
const ICNS_TYPES = [
  ['ic04', 16],
  ['ic05', 32],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic13', 256], // 128@2x
  ['ic14', 512], // 256@2x
];

function icns(pngBySize) {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const png = pngBySize.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ── .ico ────────────────────────────────────────────────────────────────────
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function ico(pngBySize) {
  const entries = ICO_SIZES.map((size) => ({ size, buf: pngBySize.get(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256 in ICO
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.buf)]);
}

// The names macOS expects inside an .iconset directory.
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_48x48.png', 48],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'icon.iconset'), { recursive: true });

  const bySize = new Map();
  for (const size of PNG_SIZES) bySize.set(size, await render(size));

  for (const size of PNG_SIZES) {
    fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), bySize.get(size));
    console.log(`  ✓ icon-${size}.png  (${masterFor(size)} master)`);
  }
  // electron-builder's default look-up
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), bySize.get(512));

  for (const [name, size] of ICONSET) {
    fs.writeFileSync(path.join(OUT_DIR, 'icon.iconset', name), bySize.get(size));
  }
  console.log(`  ✓ icon.iconset/ (${ICONSET.length} files)`);

  fs.writeFileSync(path.join(OUT_DIR, 'icon.icns'), icns(bySize));
  console.log(`  ✓ icon.icns (${ICNS_TYPES.length} representations)`);

  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico(bySize));
  console.log(`  ✓ icon.ico (${ICO_SIZES.join(', ')}px)`);

  console.log(`\n  App icon set written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
