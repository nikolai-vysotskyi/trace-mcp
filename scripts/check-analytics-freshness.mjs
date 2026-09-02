#!/usr/bin/env node
// Fails when the analytics DB has not ingested a session log recently enough.
//
// TRA-695: `~/.trace-mcp/analytics.db` stopped ingesting on 2026-08-26 and
// nobody noticed for seven days. 65,384 tool calls — 35% of the dataset — sat
// unmined while `get_session_analytics`, `get_optimization_report`,
// `get_real_savings` and `get_usage_trends` reported the stale numbers as
// current. The sync itself was fine; nothing had run it.
//
// This is the outside check on that: it compares the ingestion watermark
// (`max(sync_state.parsed_at)`) against the newest session log mtime on disk
// and fails when the gap exceeds --max-age-hours. Run it by hand, or from any
// autopilot that is about to reason about session analytics.
//
// Usage:
//   node scripts/check-analytics-freshness.mjs [--max-age-hours 24] [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DEFAULT_MAX_AGE_HOURS = 24;

/**
 * Decides freshness from the two timestamps. Pure so the thresholds are
 * testable without a database or a home directory.
 *
 * @param {{ parsedAtMs: number | null, newestLogMs: number | null, maxAgeHours: number }} input
 * @returns {{ ok: boolean, reason: string, behindHours: number | null }}
 */
export function evaluateFreshness({ parsedAtMs, newestLogMs, maxAgeHours }) {
  if (newestLogMs === null) {
    return { ok: true, reason: 'no session logs on disk', behindHours: null };
  }
  if (parsedAtMs === null) {
    return {
      ok: false,
      reason: 'analytics DB has never ingested a session log',
      behindHours: null,
    };
  }
  const behindHours = (newestLogMs - parsedAtMs) / 3_600_000;
  if (behindHours <= maxAgeHours) {
    return { ok: true, reason: 'fresh', behindHours: Math.max(0, round1(behindHours)) };
  }
  return {
    ok: false,
    reason: `ingestion watermark trails the newest session log by ${round1(behindHours)}h (limit ${maxAgeHours}h)`,
    behindHours: round1(behindHours),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** mtime (epoch ms) of the newest `*.jsonl` under ~/.claude/projects, or null. */
function newestSessionLogMtime(root) {
  let newest = null;
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(path.join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      try {
        const { mtimeMs } = fs.statSync(path.join(root, d.name, f.name));
        if (newest === null || mtimeMs > newest) newest = mtimeMs;
      } catch {
        /* skip */
      }
    }
  }
  return newest;
}

function main() {
  const argv = process.argv.slice(2);
  const maxAgeIdx = argv.indexOf('--max-age-hours');
  const maxAgeHours =
    maxAgeIdx === -1 ? DEFAULT_MAX_AGE_HOURS : Number.parseFloat(argv[maxAgeIdx + 1]);
  const asJson = argv.includes('--json');

  const dbPath = path.join(os.homedir(), '.trace-mcp', 'analytics.db');
  let watermark = { parsed_at: null, cnt: 0 };
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      watermark =
        db.prepare('SELECT MAX(parsed_at) as parsed_at, COUNT(*) as cnt FROM sync_state').get() ??
        watermark;
    } finally {
      db.close();
    }
  }

  const newestLogMs = newestSessionLogMtime(path.join(os.homedir(), '.claude', 'projects'));
  const parsedAtMs = watermark.parsed_at ? Date.parse(watermark.parsed_at) : null;
  const result = evaluateFreshness({
    parsedAtMs: Number.isNaN(parsedAtMs) ? null : parsedAtMs,
    newestLogMs,
    maxAgeHours,
  });

  const report = {
    ok: result.ok,
    reason: result.reason,
    ingested_through: watermark.parsed_at,
    files_tracked: watermark.cnt,
    newest_session_log_at: newestLogMs === null ? null : new Date(newestLogMs).toISOString(),
    behind_hours: result.behindHours,
    max_age_hours: maxAgeHours,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (result.ok) {
    console.log(`✅ analytics ingestion ${result.reason} — through ${report.ingested_through}`);
  } else {
    console.error(`❌ analytics ingestion stale: ${result.reason}`);
    console.error(`   ingested through: ${report.ingested_through}`);
    console.error(`   newest session log: ${report.newest_session_log_at}`);
    console.error('   fix: trace-mcp analytics sync');
  }

  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
