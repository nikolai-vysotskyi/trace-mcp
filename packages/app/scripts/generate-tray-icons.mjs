/**
 * Generate trace-mcp tray icons.
 *
 * macOS: monochrome black on transparent — Template images, the system tints them.
 * Windows: black for a light taskbar, white for a dark one, plus dimmed variants
 * used while the daemon is idle (see src/main/tray.ts).
 *
 * Split out of the retired scripts/generate-icons.mjs in TRA-780: the app icon
 * moved to vector masters in assets/icon/ (scripts/gen-app-icon.mjs), but the
 * tray art is a separate 32x32 drawing with no vector master, and deleting its
 * only generator would have left eight committed PNGs no one could reproduce.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'assets');

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

const configs = [
  // macOS — Template naming, black on transparent
  { name: 'tray-iconTemplate.png', size: 22, dim: false, color: 'black' },
  { name: 'tray-iconTemplate@2x.png', size: 44, dim: false, color: 'black' },
  { name: 'tray-icon-dimTemplate.png', size: 22, dim: true, color: 'black' },
  { name: 'tray-icon-dimTemplate@2x.png', size: 44, dim: true, color: 'black' },
  // Windows — black for a light taskbar, white for a dark one
  { name: 'tray-icon-light.png', size: 32, dim: false, color: 'black' },
  { name: 'tray-icon-dim-light.png', size: 32, dim: true, color: 'black' },
  { name: 'tray-icon-dark.png', size: 32, dim: false, color: 'white' },
  { name: 'tray-icon-dim-dark.png', size: 32, dim: true, color: 'white' },
];

async function generate() {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(assetsDir, { recursive: true });

  await Promise.all(
    configs.map((cfg) =>
      sharp(Buffer.from(trayIconSVG(cfg.size, cfg.dim, cfg.color)))
        .png()
        .toFile(path.join(assetsDir, cfg.name))
        .then(() => console.log(`  ✓ ${cfg.name} (${cfg.size}x${cfg.size}, ${cfg.color})`)),
    ),
  );

  console.log(`\n  Tray icons written to ${assetsDir}`);
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
