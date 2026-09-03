#!/usr/bin/env node
/**
 * Shadow-run the guard v2 navigation gate over recorded agent sessions (TRA-711).
 *
 * TRA-705 measured the trace path costing 1.45x MORE than a bare grep agent on a
 * single light navigation question, and 1.39x LESS on multi-step work. Guard v2
 * acts on that split: stay silent on an isolated navigation call, intervene once
 * the session is crawling. This script answers whether that rule actually lands
 * where the advantage is, without running a live A/B.
 *
 * It replays the tool calls in Claude Code session transcripts, classifies each
 * one with the same rules the hook uses, and reports:
 *
 *   coverage  — share of navigation calls inside a real crawl that the gate
 *               fires on. TRA-710 hypothesis 3 dies below 50%: routing is then
 *               not the lever, tool descriptions are.
 *   precision — share of gate firings that land inside a crawl rather than on a
 *               light question.
 *   spared    — navigation calls the gate now leaves alone that v1 intervened
 *               on. This is the 1.45x regression, measured.
 *
 * "Crawl" is defined INDEPENDENTLY of the detector, or the measurement would be
 * circular: a burst of >= CRAWL_MIN navigation calls close together in one
 * session. The detector's own threshold (3) is deliberately smaller, so it is
 * possible for it to miss crawls and possible for it to fire outside one.
 *
 * Usage:
 *   node scripts/guard-shadow-nav.mjs [--logs <dir>] [--nav-min 3]
 *                                     [--window 300] [--crawl-min 5] [--json]
 *
 * ── Measured 2026-09-03, 860 sessions / 92.9k tool calls (~/.claude/projects)
 *
 *   native navigation calls   13,342 (14.4% of tool calls)
 *   trace-mcp calls            4,870 (26.7% of all navigation)
 *   burst sizes               1:5211 2:1544 3:614 4:286 5:123 6:72 7:41 8:25 9:7 10+:36
 *
 *   coverage                  90.1%   (TRA-710 hypothesis 3 needed >50% — it holds)
 *   spared                    27.1%   of navigation calls v1 intervened on
 *   light turns (<=2 nav)     556 of 1,528 navigation turns (36.4%)
 *   firings in light turns    0       (v1 fired on all 556 — the 1.45x regression)
 *
 * Threshold sweep (coverage / spared): nav_min=2 95.7/15.9, 3 90.1/27.1,
 * 4 83.0/36.0, 5 75.1/43.2, 6 66.4/49.3. Three is the knee: it is the smallest
 * value that leaves every light turn alone, and the cost of going higher is
 * coverage on the crawls we actually win.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const LOGS_DIR = flag('logs', path.join(os.homedir(), '.claude', 'projects'));
const NAV_MIN = Number(flag('nav-min', 3));
const WINDOW_SEC = Number(flag('window', 300));
const CRAWL_MIN = Number(flag('crawl-min', 5));
const AS_JSON = args.includes('--json');

// ─── Classifier: mirrors hooks/trace-mcp-guard.sh ────────────────────────────
// Kept as literal copies of the shell regexes rather than a shared module: the
// hook is a standalone bash script with no way to import from here, and a
// shadow run that used a *different* rule than the hook would measure nothing.
const CODE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|c|h|hpp|swift|scala|vue|svelte|astro|blade\.php)([^a-zA-Z0-9]|$)/i;
const NONCODE_GLOB_RE = /\.(md|json|ya?ml|toml|txt|html|xml|csv|cfg|ini|lock|log)/i;
const SOURCE_DIR_RE =
  /(^|[ /])(src|lib|packages|apps?|server|client|pkg|internal|modules|services|pipelines|cmd)([/ ]|$)/;
const EXCLUDE_DIR_RE = /(node_modules|vendor|dist|build|coverage|\.git|\.trace-mcp|target|out)\//;
const SAFE_ROOT_RE = /(^|[ ])(\/tmp|\/var|\/private|\/usr|\/etc|~\/|\$HOME)/;
const SHELL_EXPLORE_RE =
  /(^|[ |;&]|xargs +)(grep|rg|find|cat|head|tail|less|more|awk|sed|bat|view|subl|code)( |$)/;
const SHELL_LIST_RE = /(^|[ |;&]|xargs +)(ls|find)( |$)/;
const GIT_READ_RE = /(^|[ |;&])git +(show|blame|cat-file|diff)( |$)/;

/** True when the guard would treat this tool call as code navigation. */
function isNavigation(name, input) {
  const i = input ?? {};
  if (name === 'Read') {
    const p = String(i.file_path ?? '');
    if (i.offset != null || i.limit != null) return false; // targeted pre-Edit read
    return CODE_EXT_RE.test(p) && !EXCLUDE_DIR_RE.test(p);
  }
  if (name === 'Grep') {
    const glob = String(i.glob ?? '');
    const type = String(i.type ?? '');
    if (NONCODE_GLOB_RE.test(glob)) return false;
    if (['md', 'json', 'yaml', 'toml', 'xml', 'html', 'csv'].includes(type)) return false;
    return !EXCLUDE_DIR_RE.test(String(i.path ?? ''));
  }
  if (name === 'Glob') return !NONCODE_GLOB_RE.test(String(i.pattern ?? ''));
  if (name === 'Bash') {
    const cmd = String(i.command ?? '');
    if (EXCLUDE_DIR_RE.test(cmd) || SAFE_ROOT_RE.test(cmd)) return false;
    if (GIT_READ_RE.test(cmd) && CODE_EXT_RE.test(cmd)) return true;
    const looksAtCode = CODE_EXT_RE.test(cmd) || SOURCE_DIR_RE.test(cmd);
    if (!looksAtCode) return false;
    return SHELL_EXPLORE_RE.test(cmd) || SHELL_LIST_RE.test(cmd);
  }
  return false;
}

/** trace-mcp's own tools — navigation that already goes through us. */
const isTraceCall = (name) => name.startsWith('mcp__trace') || name.startsWith('mcp__trace-mcp__');

// ─── Replay ──────────────────────────────────────────────────────────────────

function* sessionFiles(dir) {
  let projects;
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projDir = path.join(dir, p.name);
    for (const f of fs.readdirSync(projDir)) {
      if (f.endsWith('.jsonl')) yield path.join(projDir, f);
    }
  }
}

/**
 * Ordered event stream for one transcript: real user turns (which reset the
 * detector's streak, exactly as the UserPromptSubmit hook does) and tool calls.
 */
function readEvents(file) {
  const events = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return events;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(rec.timestamp ?? '') || 0;
    const content = rec?.message?.content;
    if (rec.type === 'user') {
      // A real user turn carries prose. Tool results are also type "user" but
      // arrive as a content array of tool_result blocks — not a new prompt.
      const isPrompt =
        typeof content === 'string' ||
        (Array.isArray(content) && content.some((b) => b?.type === 'text'));
      if (isPrompt && !rec.isMeta) events.push({ kind: 'prompt', ts });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        events.push({ kind: 'call', name: block.name, input: block.input ?? {}, ts });
      }
    }
  }
  return events;
}

const stats = {
  sessions: 0,
  sessionsWithCalls: 0,
  sessionsWithCrawl: 0,
  toolCalls: 0,
  traceCalls: 0,
  navCalls: 0,
  crawls: 0,
  crawlNavCalls: 0,
  crawlFired: 0,
  lightBursts: 0,
  lightNavCalls: 0,
  lightFired: 0,
  /** Burst-size histogram: how many bursts of each length. */
  burstSizes: {},
  /**
   * Turn-level view. A "turn" is one user prompt and everything the agent did
   * before the next one — the unit TRA-705's A/B priced. A turn with at most
   * LIGHT_TURN_NAV native navigation calls is a light question: guard v1 fired
   * on every one of them, which is where the 1.45x came from.
   */
  turnsWithNav: 0,
  lightTurns: 0,
  lightTurnFired: 0,
  heavyTurnFired: 0,
};

/** A turn with at most this many navigation calls is a light question. */
const LIGHT_TURN_NAV = Number(flag('light-turn-nav', 2));

/**
 * One pass over a session, tracking two independent things:
 *
 *   streak — the detector's own state, reset by a user prompt or a gap longer
 *            than WINDOW_SEC, exactly like the hook. Fires from NAV_MIN on.
 *   burst  — ground truth. A maximal run of navigation calls not interrupted by
 *            real work (a non-navigation tool call) or by a new user prompt.
 *            Bursts of >= CRAWL_MIN are crawls; shorter ones are light
 *            questions, the shape TRA-705 measured us losing on.
 */
function walkSession(events) {
  let streak = 0;
  let streakTs = 0;
  let burst = [];
  let sessionHasCrawl = false;
  let turnNav = 0;
  let turnFired = 0;

  const closeTurn = () => {
    if (turnNav === 0) return;
    stats.turnsWithNav++;
    if (turnNav <= LIGHT_TURN_NAV) {
      stats.lightTurns++;
      stats.lightTurnFired += turnFired;
    } else {
      stats.heavyTurnFired += turnFired;
    }
    turnNav = 0;
    turnFired = 0;
  };

  const closeBurst = () => {
    if (!burst.length) return;
    const navCalls = burst.length;
    const bucket = navCalls >= 10 ? '10+' : String(navCalls);
    stats.burstSizes[bucket] = (stats.burstSizes[bucket] ?? 0) + 1;
    const firedInBurst = burst.filter((b) => b.fired).length;
    if (navCalls >= CRAWL_MIN) {
      sessionHasCrawl = true;
      stats.crawls++;
      stats.crawlNavCalls += navCalls;
      stats.crawlFired += firedInBurst;
    } else {
      stats.lightBursts++;
      stats.lightNavCalls += navCalls;
      stats.lightFired += firedInBurst;
    }
    burst = [];
  };

  for (const e of events) {
    if (e.kind === 'prompt') {
      streak = 0;
      streakTs = 0;
      closeBurst();
      closeTurn();
      continue;
    }
    stats.toolCalls++;
    if (isTraceCall(e.name)) {
      stats.traceCalls++;
      continue; // already routed through us: neither a firing nor real work
    }
    if (!isNavigation(e.name, e.input)) {
      closeBurst();
      continue;
    }
    stats.navCalls++;
    const gap = streakTs && e.ts ? (e.ts - streakTs) / 1000 : 0;
    if (streakTs && gap > WINDOW_SEC) {
      streak = 0;
      closeBurst();
    }
    streak++;
    streakTs = e.ts || streakTs;
    const fired = streak >= NAV_MIN;
    turnNav++;
    if (fired) turnFired++;
    burst.push({ fired });
  }
  closeBurst();
  closeTurn();
  if (sessionHasCrawl) stats.sessionsWithCrawl++;
}

for (const file of sessionFiles(LOGS_DIR)) {
  stats.sessions++;
  const events = readEvents(file);
  if (!events.some((e) => e.kind === 'call')) continue;
  stats.sessionsWithCalls++;
  walkSession(events);
}

const pct = (a, b) => (b === 0 ? 0 : (a / b) * 100);
const fired = stats.crawlFired + stats.lightFired;
const report = {
  params: { logs: LOGS_DIR, navMin: NAV_MIN, windowSec: WINDOW_SEC, crawlMin: CRAWL_MIN },
  ...stats,
  navShareOfToolCallsPct: pct(stats.navCalls, stats.toolCalls),
  traceShareOfNavPct: pct(stats.traceCalls, stats.traceCalls + stats.navCalls),
  sessionsWithCrawlPct: pct(stats.sessionsWithCrawl, stats.sessionsWithCalls),
  coveragePct: pct(stats.crawlFired, stats.crawlNavCalls),
  precisionPct: pct(stats.crawlFired, fired),
  sparedPct: pct(stats.navCalls - fired, stats.navCalls),
  lightTurnSharePct: pct(stats.lightTurns, stats.turnsWithNav),
  lightTurnFiredPct: pct(stats.lightTurnFired, stats.lightTurns),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const r = (n) => n.toFixed(1);
  console.log(`guard v2 shadow run — ${LOGS_DIR}`);
  console.log(`  nav_min=${NAV_MIN} window=${WINDOW_SEC}s crawl_min=${CRAWL_MIN}`);
  console.log('');
  console.log(`  sessions with tool calls   ${stats.sessionsWithCalls}`);
  console.log(`  tool calls                 ${stats.toolCalls}`);
  console.log(
    `  native navigation calls    ${stats.navCalls} (${r(report.navShareOfToolCallsPct)}% of tool calls)`,
  );
  console.log(
    `  trace-mcp calls            ${stats.traceCalls} (${r(report.traceShareOfNavPct)}% of all navigation)`,
  );
  console.log('');
  console.log(
    `  crawls (>=${CRAWL_MIN} nav in a row)   ${stats.crawls} across ${stats.sessionsWithCrawl} sessions (${r(report.sessionsWithCrawlPct)}%)`,
  );
  console.log(`  light bursts (<${CRAWL_MIN})        ${stats.lightBursts}`);
  const sizes = Object.entries(stats.burstSizes).sort(
    (a, b) => (a[0] === '10+' ? 99 : Number(a[0])) - (b[0] === '10+' ? 99 : Number(b[0])),
  );
  console.log(`  burst sizes                ${sizes.map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log('');
  console.log(`  coverage  ${r(report.coveragePct)}%  of crawl navigation calls routed`);
  console.log(`  precision ${r(report.precisionPct)}%  of firings land inside a crawl`);
  console.log(
    `  spared    ${r(report.sparedPct)}%  of navigation calls the v1 guard intervened on`,
  );
  console.log('');
  console.log(
    `  turns with navigation      ${stats.turnsWithNav}, of which light (<=${LIGHT_TURN_NAV} nav calls): ${stats.lightTurns} (${r(report.lightTurnSharePct)}%)`,
  );
  console.log(
    `  firings inside light turns ${stats.lightTurnFired}  (guard v1 fired on all ${stats.lightTurns})`,
  );
}
