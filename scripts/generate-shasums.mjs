#!/usr/bin/env node
/**
 * generate-shasums.mjs — emit per-asset `<file>.sha256` files next to release
 * artifacts, plus a combined SHASUMS256.txt for ergonomic verification.
 *
 * Per-asset files contain the bare hex digest (one line, no filename) so the
 * GitHub Releases UI shows them as one-liners and our updater can verify a
 * single asset without parsing the combined manifest. Per-asset files also
 * avoid collisions in matrix builds where two parallel jobs upload artifacts
 * for different archs — each one only writes its own hashes.
 *
 * The combined SHASUMS256.txt uses GNU `sha256sum` format (`<digest>  <name>`)
 * for tooling that prefers a single manifest. Note: in matrix builds with
 * --clobber uploads, the combined file gets overwritten by the last job to
 * finish — only per-asset files are reliable for matrix scenarios. Use the
 * combined file only in single-job builds.
 *
 * Usage:
 *   node scripts/generate-shasums.mjs <dir> [.ext1] [.ext2] ...
 *
 * If no extensions are given, hashes every `.zip` and `.exe` in <dir>.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/generate-shasums.mjs <dir> [.ext...]');
  process.exit(1);
}

const exts = process.argv.slice(3);
const matchExts = exts.length > 0 ? exts : ['.zip', '.exe'];

const entries = fs
  .readdirSync(dir)
  .filter((name) => matchExts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase())))
  .filter((name) => !name.endsWith('.sha256') && name !== 'SHASUMS256.txt')
  .sort();

if (entries.length === 0) {
  console.error(`No artifacts matching ${matchExts.join(', ')} in ${dir}`);
  process.exit(1);
}

const combined = [];
for (const name of entries) {
  const full = path.join(dir, name);
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(full));
  const digest = hash.digest('hex');

  // Per-asset bare-digest file — primary format consumed by the updater.
  fs.writeFileSync(`${full}.sha256`, `${digest}\n`, 'utf-8');
  combined.push(`${digest}  ${name}`);
  console.log(`${digest}  ${name}`);
}

// Combined manifest — convenient for humans and unmatrixed jobs.
fs.writeFileSync(path.join(dir, 'SHASUMS256.txt'), `${combined.join('\n')}\n`, 'utf-8');
