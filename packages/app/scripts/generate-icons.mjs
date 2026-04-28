/**
 * Generate trace-mcp tray & app icons.
 *
 * Concept: "Trace Network" — a stylised graph of connected nodes
 * representing code-intelligence tracing. The central node is larger,
 * with branching paths radiating outward.
 *
 * Tray icons: monochrome (black on transparent) — macOS Template images.
 * App icon:   full-colour gradient background with white graph overlay.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'assets');
const buildDir = path.join(__dirname, '..', 'build');

// ── Tray icon design (graph nodes + edges) ──────────────────────────

function trayIconSVG(size, dim = false, color = 'black') {
  // Coordinates are in a 32x32 viewBox, scaled to any size
  const opacity = dim ? 0.45 : 1.0;
  const strokeW = size <= 16 ? 1.8 : 1.5;

  // Node positions (viewBox 32x32)
  const nodes = [
    { x: 16, y: 8, r: 3.2 }, // top center (main)
    { x: 7, y: 16, r: 2.4 }, // mid-left
    { x: 25, y: 16, r: 2.4 }, // mid-right
    { x: 10, y: 25, r: 2.0 }, // bottom-left
    { x: 22, y: 25, r: 2.0 }, // bottom-right
    { x: 16, y: 20, r: 2.8 }, // center hub
  ];

  // Edges (index pairs)
  const edges = [
    [0, 5], // top → center
    [5, 1], // center → left
    [5, 2], // center → right
    [1, 3], // left → bottom-left
    [2, 4], // right → bottom-right
    [5, 3], // center → bottom-left (cross)
    [5, 4], // center → bottom-right (cross)
  ];

  const edgesSVG = edges
    .map(
      ([a, b]) =>
        `<line x1="${nodes[a].x}" y1="${nodes[a].y}" x2="${nodes[b].x}" y2="${nodes[b].y}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" opacity="${opacity}"/>`,
    )
    .join('\n    ');

  const nodesSVG = nodes
    .map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${color}" opacity="${opacity}"/>`)
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
    ${edgesSVG}
    ${nodesSVG}
  </svg>`;
}

// ── App icon design (colour, for dock / installer) ──────────────────

function appIconSVG(size) {
  // Original layout — the one that looked great
  const nodes = [
    { x: 256, y: 100, r: 22 }, // 0 top
    { x: 120, y: 215, r: 18 }, // 1 mid-left
    { x: 392, y: 215, r: 18 }, // 2 mid-right
    { x: 160, y: 365, r: 16 }, // 3 bottom-left
    { x: 352, y: 365, r: 16 }, // 4 bottom-right
    { x: 256, y: 265, r: 62 }, // 5 center hub — BIG heart
    { x: 80, y: 335, r: 13 }, // 6 far bottom-left
    { x: 432, y: 335, r: 13 }, // 7 far bottom-right
    { x: 256, y: 430, r: 15 }, // 8 bottom center
  ];

  const edges = [
    [0, 5],
    [5, 1],
    [5, 2],
    [1, 3],
    [2, 4],
    [5, 3],
    [5, 4],
    [1, 6],
    [2, 7],
    [5, 8],
    [3, 8],
    [4, 8],
  ];

  const edgesSVG = edges
    .map(
      ([a, b]) =>
        `<line x1="${nodes[a].x}" y1="${nodes[a].y}" x2="${nodes[b].x}" y2="${nodes[b].y}" stroke="rgba(255,255,255,0.55)" stroke-width="4.5" stroke-linecap="round"/>`,
    )
    .join('\n      ');

  // Soft glow behind nodes
  const glowSVG = nodes
    .map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${n.r * 1.8}" fill="rgba(255,255,255,0.07)"/>`)
    .join('\n      ');

  const nodesSVG = nodes
    .map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="white" opacity="0.95"/>`)
    .join('\n      ');

  // Single subtle ring around the hub
  const hubRing = `<circle cx="256" cy="265" r="76" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>`;

  // macOS expects ~18% padding around the icon artwork
  const pad = 46; // padding on each side in viewBox units
  const inner = 512 - pad * 2; // 420
  const scale = (inner / 512).toFixed(4); // ~0.8203

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#6C3CE0"/>
        <stop offset="50%" stop-color="#4F46E5"/>
        <stop offset="100%" stop-color="#2563EB"/>
      </linearGradient>
      <linearGradient id="shine" x1="0.5" y1="0" x2="0.5" y2="0.4">
        <stop offset="0%" stop-color="rgba(255,255,255,0.15)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
      </linearGradient>
      <!-- Radial mask: grid fades to transparent at edges -->
      <mask id="gridFade">
        <radialGradient id="gridFadeGrad" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stop-color="white"/>
          <stop offset="60%" stop-color="white"/>
          <stop offset="100%" stop-color="black"/>
        </radialGradient>
        <rect width="512" height="512" fill="url(#gridFadeGrad)"/>
      </mask>
    </defs>
    <!-- Scale down with padding so macOS dock sizes it correctly -->
    <g transform="translate(${pad}, ${pad}) scale(${scale})">
    <!-- Background -->
    <rect width="512" height="512" rx="110" ry="110" fill="url(#bg)"/>
    <rect width="512" height="512" rx="110" ry="110" fill="url(#shine)"/>
    <!-- Subtle grid with edge fade -->
    <g opacity="0.22" mask="url(#gridFade)">
      ${Array.from({ length: 9 }, (_, i) => `<line x1="${56 * (i + 1)}" y1="60" x2="${56 * (i + 1)}" y2="452" stroke="white" stroke-width="1"/>`).join('\n      ')}
      ${Array.from({ length: 7 }, (_, i) => `<line x1="60" y1="${56 * (i + 1) + 30}" x2="452" y2="${56 * (i + 1) + 30}" stroke="white" stroke-width="1"/>`).join('\n      ')}
    </g>
    <!-- Graph -->
    <g>
      ${edgesSVG}
      ${glowSVG}
      ${hubRing}
      ${nodesSVG}
    </g>
    <!-- "T" in center hub -->
    <text x="256" y="265" text-anchor="middle" dominant-baseline="central" font-family="SF Pro Display, Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="62" fill="rgba(79,70,229,0.9)">T</text>
    </g>
  </svg>`;
}

// ── Generate all files ──────────────────────────────────────────────

async function generate() {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(assetsDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  const tasks = [];

  // Tray icons — macOS (Template naming, black on transparent — macOS auto-tints)
  const trayConfigs = [
    { name: 'tray-iconTemplate.png', size: 22, dim: false },
    { name: 'tray-iconTemplate@2x.png', size: 44, dim: false },
    { name: 'tray-icon-dimTemplate.png', size: 22, dim: true },
    { name: 'tray-icon-dimTemplate@2x.png', size: 44, dim: true },
  ];

  for (const cfg of trayConfigs) {
    const svg = trayIconSVG(cfg.size, cfg.dim);
    const outPath = path.join(assetsDir, cfg.name);
    tasks.push(
      sharp(Buffer.from(svg))
        .png()
        .toFile(outPath)
        .then(() => console.log(`  ✓ ${cfg.name} (${cfg.size}x${cfg.size})`)),
    );
  }

  // Tray icons — Windows (white for dark taskbar, black for light taskbar)
  const winTrayConfigs = [
    { name: 'tray-icon-light.png', size: 32, dim: false, color: 'black' }, // for light taskbar
    { name: 'tray-icon-dim-light.png', size: 32, dim: true, color: 'black' },
    { name: 'tray-icon-dark.png', size: 32, dim: false, color: 'white' }, // for dark taskbar
    { name: 'tray-icon-dim-dark.png', size: 32, dim: true, color: 'white' },
  ];

  for (const cfg of winTrayConfigs) {
    const svg = trayIconSVG(cfg.size, cfg.dim, cfg.color);
    const outPath = path.join(assetsDir, cfg.name);
    tasks.push(
      sharp(Buffer.from(svg))
        .png()
        .toFile(outPath)
        .then(() =>
          console.log(`  ✓ ${cfg.name} (${cfg.size}x${cfg.size}, ${cfg.color} — Windows)`),
        ),
    );
  }

  // App icon at multiple sizes (for electron-builder)
  const appSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  for (const size of appSizes) {
    const svg = appIconSVG(512); // render at 512, resize down
    const outPath = path.join(buildDir, `icon-${size}.png`);
    tasks.push(
      sharp(Buffer.from(svg))
        .resize(size, size)
        .png()
        .toFile(outPath)
        .then(() => console.log(`  ✓ icon-${size}.png`)),
    );
  }

  // Main icon.png (512x512 for electron-builder default)
  const mainSvg = appIconSVG(512);
  tasks.push(
    sharp(Buffer.from(mainSvg))
      .resize(512, 512)
      .png()
      .toFile(path.join(buildDir, 'icon.png'))
      .then(() => console.log(`  ✓ icon.png (512x512)`)),
  );

  await Promise.all(tasks);

  // ── Windows .ico (multi-size icon) ──────────────────────────────
  // ICO format: header + directory entries + PNG payloads
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = [];
  for (const size of icoSizes) {
    const svg = appIconSVG(512);
    const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
    pngBuffers.push({ size, buf });
  }

  // ICO header: 3 x uint16 (reserved=0, type=1, count)
  const headerSize = 6;
  const dirEntrySize = 16;
  const numImages = pngBuffers.length;
  let dataOffset = headerSize + dirEntrySize * numImages;
  const dirEntries = [];
  for (const { size, buf } of pngBuffers) {
    const w = size >= 256 ? 0 : size; // 0 means 256 in ICO format
    const h = w;
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(w, 0); // width
    entry.writeUInt8(h, 1); // height
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buf.length, 8); // image size
    entry.writeUInt32LE(dataOffset, 12); // data offset
    dirEntries.push(entry);
    dataOffset += buf.length;
  }

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(numImages, 4); // count

  const { writeFile } = await import('node:fs/promises');
  const icoBuffer = Buffer.concat([header, ...dirEntries, ...pngBuffers.map((p) => p.buf)]);
  const icoPath = path.join(buildDir, 'icon.ico');
  await writeFile(icoPath, icoBuffer);
  console.log(`  ✓ icon.ico (${icoSizes.join(', ')}px — Windows)`);

  console.log('\n  All icons generated!');
  console.log(`  Tray icons: ${assetsDir}`);
  console.log(`  App icons:  ${buildDir}`);
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
