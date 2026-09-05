/**
 * TRA-861 offline gate: structural-unit selection vs the line-level selectors
 * TRA-758 measured.
 *
 * Same corpus, same evidence-recall metric, same 0.85 threshold. The single
 * changed variable is the unit of selection: a symbol with its body, not a
 * line. Run with `pnpm exec tsx benchmarks/skeleton-gate/eval.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getParser, LANG_GRAMMARS, type TSNode } from '../../src/parser/tree-sitter.js';

type Call = {
  tool: 'Read' | 'Bash';
  input: Record<string, unknown>;
  chars: number;
  bucket: string;
  query: string;
  output: string;
  evidence: number[];
};

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEP_HEAD = 24;
const KEEP_TAIL = 12;
const CAP_CHARS = 3000;
const TARGET_CUT = Number(process.env.TARGET_CUT ?? 0.5);

// ---------------------------------------------------------------- selectors

const READ_PREFIX = /^\s*\d+\t/;
const stripPrefix = (l: string) => l.replace(READ_PREFIX, '');
const norm = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');

/** hook steps 2+3: collapse repeats, then a head/tail line window. */
function windowSelect(lines: string[]): string[] {
  const collapsed: string[] = [];
  let prev: string | null = null;
  let run = 0;
  for (const line of lines) {
    if (prev !== null && line === prev) {
      run++;
      continue;
    }
    if (run > 0) {
      collapsed.push(`  … previous line repeated ${run} more time(s)`);
      run = 0;
    }
    collapsed.push(line);
    prev = line;
  }
  if (run > 0) collapsed.push(`  … previous line repeated ${run} more time(s)`);

  if (collapsed.length <= KEEP_HEAD + KEEP_TAIL) return collapsed;
  return [
    ...collapsed.slice(0, KEEP_HEAD),
    `  … ${collapsed.length - KEEP_HEAD - KEEP_TAIL} line(s) elided by trace-mcp mirror …`,
    ...collapsed.slice(-KEEP_TAIL),
  ];
}

function charCap(text: string): string {
  if (text.length <= CAP_CHARS) return text;
  const head = Math.floor((CAP_CHARS * 2) / 3);
  return `${text.slice(0, head)}\n  … ${text.length - CAP_CHARS} char(s) elided …\n${text.slice(-(CAP_CHARS - head))}`;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  php: 'php',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  lua: 'lua',
  vue: 'vue',
  sh: 'bash',
  bash: 'bash',
  ex: 'elixir',
  exs: 'elixir',
  dart: 'dart',
  zig: 'zig',
};

function languageOf(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const lang = EXT_LANG[ext];
  return lang && LANG_GRAMMARS[lang] ? lang : null;
}

const UNIT_RE =
  /(function|method|class|struct|interface|enum|impl|trait|module|constructor|declaration|definition|arrow)/;

type Unit = { start: number; end: number; header: number; text: string };

/**
 * Structural units of a parsed file: a node that owns a multi-line body.
 * We keep the outermost such node per region -- a class is one unit, not one
 * per method -- so a "keep" decision never lands mid-construct.
 */
function unitsOf(root: TSNode, minLines = 4): Unit[] {
  const out: Unit[] = [];
  const walk = (node: TSNode) => {
    const span = node.endPosition.row - node.startPosition.row;
    if (UNIT_RE.test(node.type) && span >= minLines) {
      out.push({
        start: node.startPosition.row,
        end: node.endPosition.row,
        header: node.childForFieldName?.('body')?.startPosition.row ?? node.startPosition.row,
        text: node.text,
      });
      return; // outermost wins
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return out;
}

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    const t = raw.toLowerCase();
    out.add(t);
    for (const part of raw.split(/(?=[A-Z])|_/)) if (part.length > 2) out.add(part.toLowerCase());
  }
  return out;
}

/**
 * HCP's rule, applied inside one file: what the question is about keeps its
 * body, everything else keeps its signature. Scoring is lexical on purpose --
 * TRA-758 proved the cost of a model here, and the claim under test is that
 * the unit of selection carries the result, not the ranker.
 */
async function skeletonSelect(
  call: Call,
  targetCut = TARGET_CUT,
  oracle = false,
): Promise<string | null> {
  const path = String(call.input.file_path ?? '');
  const lang = languageOf(path);
  if (!lang) return null;

  const lines = call.output.split('\n');
  const bodies = lines.map(stripPrefix);
  const parser = await getParser(lang);
  const tree = parser.parse(bodies.join('\n'));
  const units = unitsOf(tree.rootNode).filter((u) => u.end < lines.length);
  if (units.length === 0) return null;

  const q = tokens(call.query);
  const ev = new Set(call.evidence);
  const scored = units
    .map((u) => {
      if (oracle) {
        // Upper bound: perfect focus selection. Measures whether evidence is
        // concentrated in a few units at all -- i.e. whether any ranker could win.
        let n = 0;
        for (let i = u.start; i <= u.end; i++) if (ev.has(i)) n++;
        return { u, score: n > 0 ? 1 : 0 };
      }
      const sig = tokens(bodies.slice(u.start, Math.min(u.end, u.start + 3)).join(' '));
      let hit = 0;
      for (const t of sig) if (q.has(t)) hit++;
      return { u, score: hit / Math.max(4, sig.size) };
    })
    .sort((a, b) => b.score - a.score);

  const inUnit = new Uint8Array(lines.length);
  for (const { u } of scored) for (let i = u.start; i <= u.end; i++) inUnit[i] = 1;

  // Floor: everything outside a unit (imports, top-level consts, exports) plus
  // one signature line per unit. Then spend what is left of the budget on
  // whole bodies, highest-scoring first.
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) if (!inUnit[i]) keep[i] = 1;
  for (const { u } of scored)
    for (let i = u.start; i <= Math.min(u.header, u.end); i++) keep[i] = 1;

  const budget = Math.floor(call.chars * (1 - targetCut));
  const size = () => {
    let n = 0;
    for (let i = 0; i < lines.length; i++) if (keep[i]) n += lines[i].length + 1;
    return n;
  };
  let used = size();
  for (const { u, score } of scored) {
    if (oracle && score === 0) continue;
    let cost = 0;
    for (let i = u.start; i <= u.end; i++) if (!keep[i]) cost += lines[i].length + 1;
    if (!oracle && used + cost > budget) continue;
    for (let i = u.start; i <= u.end; i++) keep[i] = 1;
    used += cost;
  }

  const out: string[] = [];
  let elided = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (elided > 0) {
        out.push(`  … ${elided} line(s) of body elided by trace-mcp mirror …`);
        elided = 0;
      }
      out.push(lines[i]);
    } else elided++;
  }
  if (elided > 0) out.push(`  … ${elided} line(s) of body elided by trace-mcp mirror …`);
  return out.join('\n');
}

/** A head/tail window trimmed to a given char budget -- the same mass the
 * structural arm spends, so the two arms differ only in what they keep. */
function windowToBudget(lines: string[], budget: number): string {
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  let j = lines.length - 1;
  while (i <= j && used < budget) {
    if (head.length * 1 <= tail.length * 2) {
      head.push(lines[i]);
      used += lines[i].length + 1;
      i++;
    } else {
      tail.unshift(lines[j]);
      used += lines[j].length + 1;
      j--;
    }
  }
  return [...head, `  … ${j - i + 1} line(s) elided …`, ...tail].join('\n');
}

async function unitStats(call: Call): Promise<{ total: number; withEvidence: number } | null> {
  const lang = languageOf(String(call.input.file_path ?? ''));
  if (!lang) return null;
  const lines = call.output.split('\n');
  const parser = await getParser(lang);
  const units = unitsOf(parser.parse(lines.map(stripPrefix).join('\n')).rootNode).filter(
    (u) => u.end < lines.length,
  );
  const ev = new Set(call.evidence);
  let withEvidence = 0;
  for (const u of units) {
    for (let i = u.start; i <= u.end; i++)
      if (ev.has(i)) {
        withEvidence++;
        break;
      }
  }
  return { total: units.length, withEvidence };
}

// ------------------------------------------------------------------ metrics

function recall(call: Call, compressed: string): number {
  const lines = call.output.split('\n');
  const hay = norm(compressed);
  let hit = 0;
  for (const idx of call.evidence) {
    const n = norm(stripPrefix(lines[idx]));
    if (n.length > 0 && hay.includes(n)) hit++;
  }
  return call.evidence.length === 0 ? 1 : hit / call.evidence.length;
}

type Row = {
  name: string;
  cut: number;
  recall: number;
  median: number;
  fail: number;
  n: number;
  ms: number;
};

function summarise(
  name: string,
  results: { orig: number; out: number; r: number }[],
  ms: number,
): Row {
  const origMass = results.reduce((a, b) => a + b.orig, 0);
  const outMass = results.reduce((a, b) => a + b.out, 0);
  const recalls = results.map((r) => r.r).sort((a, b) => a - b);
  return {
    name,
    n: results.length,
    cut: (origMass - outMass) / origMass,
    recall: recalls.reduce((a, b) => a + b, 0) / recalls.length,
    median: recalls[Math.floor(recalls.length / 2)],
    fail: recalls.filter((r) => r < 0.85).length / recalls.length,
    ms,
  };
}

async function main() {
  const calls: Call[] = JSON.parse(readFileSync(join(HERE, 'dataset.json'), 'utf8'));
  const rss0 = process.memoryUsage().rss;

  const arms: Record<string, { orig: number; out: number; r: number }[]> = {
    'window 24/12': [],
    'window 24/12 + cap 3000': [],
    'structural units (Read only)': [],
    'structural units, Read subset': [],
    'window 24/12, Read subset': [],
    'skeleton floor: signatures only, Read subset': [],
    'window at the same budget, Read subset': [],
    'ORACLE structural focus, Read subset': [],
    'ORACLE line focus, Read subset': [],
  };
  const timing: Record<string, number> = {};
  const spread: number[] = [];
  const unitCount: number[] = [];

  for (const call of calls) {
    const lines = call.output.split('\n');

    let t = performance.now();
    const win = windowSelect(lines).join('\n');
    timing['window 24/12'] = (timing['window 24/12'] ?? 0) + (performance.now() - t);
    arms['window 24/12'].push({ orig: call.chars, out: win.length, r: recall(call, win) });

    const capped = charCap(win);
    arms['window 24/12 + cap 3000'].push({
      orig: call.chars,
      out: capped.length,
      r: recall(call, capped),
    });

    t = performance.now();
    const skel = call.tool === 'Read' ? await skeletonSelect(call) : null;
    timing.structural = (timing.structural ?? 0) + (performance.now() - t);
    const chosen = skel ?? win;
    arms['structural units (Read only)'].push({
      orig: call.chars,
      out: chosen.length,
      r: recall(call, chosen),
    });
    if (skel !== null) {
      arms['structural units, Read subset'].push({
        orig: call.chars,
        out: skel.length,
        r: recall(call, skel),
      });
      arms['window 24/12, Read subset'].push({
        orig: call.chars,
        out: win.length,
        r: recall(call, win),
      });
      const floor = (await skeletonSelect(call, 1)) ?? skel;
      arms['skeleton floor: signatures only, Read subset'].push({
        orig: call.chars,
        out: floor.length,
        r: recall(call, floor),
      });
      const stat = await unitStats(call);
      if (stat) {
        spread.push(stat.withEvidence);
        unitCount.push(stat.total);
      }
      const oracleOut = (await skeletonSelect(call, TARGET_CUT, true)) ?? skel;
      arms['ORACLE structural focus, Read subset'].push({
        orig: call.chars,
        out: oracleOut.length,
        r: recall(call, oracleOut),
      });
      const evSet = new Set(call.evidence);
      const lineOracle = lines.filter((_, i) => evSet.has(i)).join('\n');
      arms['ORACLE line focus, Read subset'].push({
        orig: call.chars,
        out: lineOracle.length,
        r: recall(call, lineOracle),
      });
      const iso = windowToBudget(lines, skel.length);
      arms['window at the same budget, Read subset'].push({
        orig: call.chars,
        out: iso.length,
        r: recall(call, iso),
      });
    }
  }

  console.log(
    `evidence-bearing structural units: mean ${(spread.reduce((a, b) => a + b, 0) / Math.max(1, spread.length)).toFixed(2)} of ${(unitCount.reduce((a, b) => a + b, 0) / Math.max(1, unitCount.length)).toFixed(2)} units per file`,
  );

  const rows = Object.entries(arms)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) =>
      summarise(
        k,
        v,
        k.startsWith('structural')
          ? timing.structural / calls.length
          : timing['window 24/12'] / calls.length,
      ),
    );

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(
    `\ncalls: ${calls.length} (Read ${calls.filter((c) => c.tool === 'Read').length}, Bash ${calls.filter((c) => c.tool === 'Bash').length})`,
  );
  console.log(
    `evidence lines/call: median ${[...calls.map((c) => c.evidence.length)].sort((a, b) => a - b)[Math.floor(calls.length / 2)]}`,
  );
  console.log('\n| arm | n | mass cut | mean recall | median recall | recall<0.85 | ms/call |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.name} | ${r.n} | ${pct(r.cut)} | ${pct(r.recall)} | ${pct(r.median)} | ${pct(r.fail)} | ${r.ms.toFixed(2)} |`,
    );
  }
  console.log(
    `\nRSS delta over the run: ${((process.memoryUsage().rss - rss0) / 1e6).toFixed(1)} MB`,
  );
}

main();
