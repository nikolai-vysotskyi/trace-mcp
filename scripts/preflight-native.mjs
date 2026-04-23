#!/usr/bin/env node
/**
 * Preflight for native (.node) modules on macOS.
 *
 * Problem: immediately after `npm install` extracts a prebuilt ad-hoc-signed
 * `.node` bundle, the first `dlopen()` of that file can race with macOS's
 * first-load code-signature validation (amfid/syspolicyd), producing:
 *
 *   Error: dlopen(...watcher.node): code signature in <uuid> not valid for use
 *   in process: library load disallowed by system policy
 *
 * The file itself is valid (`codesign --verify` passes); subsequent loads
 * succeed. Running `codesign --verify` synchronously on each `.node` forces
 * that validation to complete inside postinstall, so the user's first CLI
 * invocation sees a warmed amfid cache.
 *
 * Read-only, no xattr mutation, no file mutation. Best-effort: silent on
 * all failures, never fails `npm install`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') process.exit(0);
if (process.env.TRACE_MCP_NO_PREFLIGHT === '1') process.exit(0);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

if (!fs.existsSync(NODE_MODULES)) process.exit(0);

function findNodeBinaries(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      findNodeBinaries(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      out.push(full);
    }
  }
  return out;
}

function primeCodesign(file) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', file], {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    /* swallow — even if verify rejects, we've asked macOS to assess, which is the goal */
  }
}

try {
  const binaries = findNodeBinaries(NODE_MODULES);
  for (const bin of binaries) primeCodesign(bin);
} catch {
  /* preflight must never fail the install */
}
