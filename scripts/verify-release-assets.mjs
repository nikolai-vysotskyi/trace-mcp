#!/usr/bin/env node

/**
 * verify-release-assets.mjs — assert a GitHub Release carries every artifact
 * the updaters need, before npm advertises that version as `latest`.
 *
 * Why this gate exists: `scripts/postinstall-app.mjs` resolves the update from
 * `/releases/latest` and returns silently when the arch zip or its `.sha256`
 * sibling is absent (see its `if (!asset) return;` / `if (!checksumAsset) return;`
 * paths). A release that ships without those files therefore does not fail an
 * install — it produces an install that quietly keeps the old `.app`, which is
 * exactly the invisible failure mode TRA-357 was reported for. The only place
 * that can notice is the release itself, so it is checked here.
 *
 * Usage:
 *   gh release view <tag> --json assets -q '.assets' |
 *     node scripts/verify-release-assets.mjs <version>
 *
 * Exits non-zero (and names what is missing) when anything is absent or empty.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Artifacts an updater or a human resolves by name, plus the checksum each
 * requires. The two channel files are listed separately: electron-updater
 * resolves them by a fixed name and they ship without a `.sha256` sibling.
 */
export function expectedAssets(version) {
  return [
    ...[
      `trace-mcp-${version}-arm64-mac.zip`, // macOS Apple silicon (Squirrel.Mac)
      `trace-mcp-${version}-mac.zip`, // macOS Intel (Squirrel.Mac)
      // The signed+notarized DMGs are the only macOS download a human gets
      // (TRA-436). They are not an updater input, but a release that lost one
      // leaves that architecture with no installable build and nothing else
      // notices, so it is asserted here with everything else.
      `trace-mcp-${version}-arm64.dmg`, // macOS Apple silicon installer
      `trace-mcp-${version}-x64.dmg`, // macOS Intel installer
      `trace-mcp-${version}-win.zip`, // Windows portable
      `trace-mcp.Setup.${version}.exe`, // Windows NSIS installer
    ].flatMap((name) => [name, `${name}.sha256`]),
    // Without these, every installed app polls a feed that 404s and no update
    // is ever offered again — silently, on both platforms (TRA-437).
    'latest-mac.yml',
    'latest.yml',
  ];
}

/**
 * @param {string} version
 * @param {Array<{name: string, size?: number}>} assets  `gh release view --json assets`
 * @returns {string[]} human-readable problems; empty means the release is complete
 */
export function auditReleaseAssets(version, assets) {
  const bySize = new Map(assets.map((a) => [a.name, a.size ?? 0]));
  const problems = [];
  for (const name of expectedAssets(version)) {
    if (!bySize.has(name)) {
      problems.push(`missing: ${name}`);
      continue;
    }
    // A truncated upload keeps the name and loses the content — postinstall
    // would fetch it, fail the digest compare, and give up just as silently.
    const min = name.endsWith('.sha256') ? 64 : 1;
    if (bySize.get(name) < min) {
      problems.push(`empty or truncated: ${name} (${bySize.get(name)} bytes)`);
    }
  }
  return problems;
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('usage: node scripts/verify-release-assets.mjs <version> < assets.json');
    process.exit(1);
  }

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const assets = JSON.parse(raw);

  const problems = auditReleaseAssets(version, assets);
  if (problems.length > 0) {
    console.error(`Release ${version} is incomplete — updates would silently no-op:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  console.log(`Release ${version}: all ${expectedAssets(version).length} assets present.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
