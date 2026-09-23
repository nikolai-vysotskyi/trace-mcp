/**
 * The gate for the defect class in TRA-1005: unbounded `IN (?, ?, ...)`
 * lists against SQLite.
 *
 * Two ceilings conspire here:
 *  1. SQLite's SQLITE_MAX_VARIABLE_NUMBER (32 766 in better-sqlite3) —
 *     a single `WHERE id IN (${placeholders})` built from a full id array
 *     throws `SqliteError: too many SQL variables` past ~32k ids (and at
 *     ~16k when the same array feeds TWO `IN` lists in one statement).
 *  2. V8's argument ceiling (~65k) — spreading the whole array into
 *     `.all(...ids)` / `.run(...ids)` throws
 *     `RangeError: Maximum call stack size exceeded` past ~65k elements.
 *
 * On large indexes (>16k files / >32k symbols) the scoped (incremental)
 * resolvers and the repository batch getters all sit exactly on these
 * paths, so an unchunked call is a hard crash, not a slowdown.
 *
 * The rule is PER QUERY, not per file: every dynamic `IN (${...})` in
 * `src/` must have its placeholder expression bound to a chunked array
 * (`chunk.map(() => '?')` where `chunk` comes from `.slice(...)`) or to a
 * statically-bounded set (edge-type names, HTTP methods, symbol kinds,
 * language lists — dozens of elements by construction), AND the
 * `.all()/.run()/.get()` call consuming that statement must spread only
 * bounded arrays. A file carrying `const CHUNK = 900` for one query while
 * another query spreads a whole id-array is still a crash — the file-level
 * heuristic this gate used before TRA-1005-review could not see it (the
 * reviewer's mutation check proved it: reverting the parent lookup in
 * `insertSymbols` to `.all(...unique)` stayed green). Exempt files stay
 * listed in BOUNDED_EXEMPT with a frozen interpolation count and a
 * justification. Chunk results accumulate with a loop
 * (`for (const r of rows) out.push(r)`) because `push(...rows)` spreads
 * through Function.apply and blows the stack itself at a few hundred
 * thousand rows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DYNAMIC_IN = /IN\s*\(\$\{([^}]+)\}\)/g;

// Placeholder sources bounded by schema or by a fixed literal list — they
// cannot grow with the index: language tuples, HTTP verbs, symbol kinds,
// edge-type registries, small exclusion sets, fixed allow-lists.
const BOUNDED_SRC_IDENT =
  /\b(TS_JS_LANGS|HTTP_METHODS|httpMethods|CODE_LANGUAGES|CROSS_FILE_TYPES|VIRTUAL_TYPES|ALLOWED\w*|MARKDOWN_[A-Z_]+|excluded\w*|kinds|edgeTypeNames)\b/;

// Whole-array variable names that must never be spread into a single
// `.all()/.run()/.get()` call — each is an index-sized id list (scoped file
// ids, symbol/node id batches). After chunking, only `...chunk`-style
// (bounded) spreads remain. This is a backstop for spreads with no visible
// dynamic `IN` in the same statement; the per-query spread check below is
// the primary guard.
const BANNED_SPREAD =
  /(?:\.all|\.run|\.get)\([^)]*\.\.\.(scopedIds|fileIds|scopedSourceIds|changedFileIds|scopedBranchParams|nodeIdArr|fileRefIds|domainIds)\b/;

// Whole result-array accumulations that must stay loop-pushes: spreading a
// chunk's rows through `push(...rows)` reintroduces the V8 ceiling the
// chunking removed. Scoped to indexer/db where result sets are index-sized
// (CLI/topology `push(...smallLiteral)` sites are out of scope).
const BANNED_RESULT_SPREAD = /push\(\s*\.\.\.\s*(rows|chunkRows|fullRows|allFileSyms)\b/;

// Files whose dynamic `IN` lists are bounded at runtime by construction
// (registry/taxonomy cardinalities — single/double digits in practice).
// `dynamicInCount` freezes the interpolation count: adding a NEW dynamic
// `IN` to one of these files fails loudly and forces a justification.
const BOUNDED_EXEMPT: Record<string, { reason: string; dynamicInCount: number }> = {
  'src/topology/topology-subprojects.ts': {
    reason:
      'service/subproject registry ids (operator-configured topologies, single digits; ' +
      'spreads are .run(...svcIds)-shaped over the same bounded sets)',
    dynamicInCount: 9,
  },
  'src/intent/domain-store.ts': {
    reason: 'domain taxonomy ids (collectDescendantIds over a handful of configured domains)',
    dynamicInCount: 1,
  },
  'src/memory/decision-store.ts': {
    reason:
      'stale project roots (pruneStale/findStaleRoots over registered project dirs) and ' +
      'dead mined-session paths — hundreds at most, never index-sized',
    dynamicInCount: 11,
  },
  'src/memory/decision-store-session-ops.ts': {
    reason: 'session paths of a single project (listAllSessions-scoped, hundreds at most)',
    dynamicInCount: 1,
  },
  'src/tools/register/memory.ts': {
    reason: 'decision ids of one LIMIT-capped (<= 100) listing — see the P1.1 comment at the query',
    dynamicInCount: 1,
  },
};

/** Platform-proof path key: `node:path.join` yields `\` on Windows. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // `join()` yields backslashes on Windows — normalize so BOUNDED_EXEMPT
      // lookups and `startsWith('src/...')` filters below behave identically
      // on every platform (TRA-1804: unnormalized paths missed all exemptions
      // on windows-latest and flagged exempt files as offenders).
      const full = norm(join(dir, entry.name));
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk('src');
  return out;
}

const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * Nearest `const|let <name> = <rhs>` definition to a use site: the closest
 * preceding one wins, otherwise the closest following one. Position matters
 * because one name can serve several queries in different scopes
 * (`arr` is both the chunked symbol preload and the edge-type list in
 * edge-resolver.ts) — first-in-file resolution binds the wrong query.
 */
function nearestDef(text: string, name: string, useIdx: number): string | null {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*([^;\\n]+)`, 'g');
  let best: string | null = null;
  let bestScore = Infinity;
  for (const m of text.matchAll(re)) {
    const score = m.index <= useIdx ? useIdx - m.index : m.index - useIdx + 1e9;
    if (score < bestScore) {
      bestScore = score;
      best = m[1].trim();
    }
  }
  return best;
}

/** `const|let <name> = ... .slice(` — i.e. a chunk binding. */
function isSliceDerived(text: string, name: string): boolean {
  return new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*[^;\\n]*\\.slice\\(`).test(text);
}

/**
 * The receiver feeding a placeholder builder: `chunk` in
 * `chunk.map(() => '?')`, `CODE_LANGUAGES` in
 * `Array.from(CODE_LANGUAGES, () => '?')`, `MARKDOWN_SYMBOL_KINDS` in
 * `[...MARKDOWN_SYMBOL_KINDS].map(() => '?')`, `n` in
 * `new Array(n).fill('?')`. Null when unparseable.
 */
function placeholderReceiver(rhs: string): string | null {
  let m = rhs.match(new RegExp(`^\\s*(${IDENT})\\s*\\.map\\(\\(\\) => '\\?'\\)`));
  if (m) return m[1];
  m = rhs.match(new RegExp(`Array\\.from\\(\\s*(${IDENT})`));
  if (m && rhs.includes(`() => '?'`)) return m[1];
  m = rhs.match(new RegExp(`\\.\\.\\.(${IDENT})`));
  if (m && rhs.includes(`() => '?'`)) return m[1];
  m = rhs.match(new RegExp(`new Array\\(\\s*(${IDENT})\\s*\\)\\.fill\\('\\?'\\)`));
  if (m) return m[1];
  return null;
}

/** A right-hand side that constructs `?` placeholder lists. */
function buildsPlaceholders(rhs: string): boolean {
  return rhs.includes(`() => '?'`) || /\.fill\('\?'\)/.test(rhs);
}

/** Line index of `const|let <name> =`, if any. */
function defLine(lines: string[], name: string): number | null {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

/**
 * A receiver is bounded when it names a static set outright, or its
 * definition slices a chunk or derives from a static set
 * (`arr` from `Array.from(edgeTypeNames)`), or it is a size parameter
 * whose every call-site argument is chunk-derived
 * (`edgesForNodesStmt(chunk.length)` — the TRA-651 sized-statement cache).
 */
function isBoundedReceiver(text: string, receiver: string, useIdx: number): boolean {
  if (BOUNDED_SRC_IDENT.test(receiver)) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(receiver)) return true; // fixed const lists
  const def = nearestDef(text, receiver, useIdx);
  if (def != null) {
    if (def.includes('.slice(')) return true;
    if (BOUNDED_SRC_IDENT.test(def)) return true;
    return false;
  }
  // No variable definition: maybe a function parameter with bounded
  // call sites (sized-statement caches).
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fn = lines[i].match(
      new RegExp(`^\\s*(?:private\\s+|async\\s+)?(${IDENT})\\s*\\(([^)]*)\\)`),
    );
    if (!fn) continue;
    const params = fn[2].split(',').map((p) => p.trim().split(':')[0].trim());
    if (!params.includes(receiver)) continue;
    const sites: string[] = [];
    const callRe = new RegExp(`\\b${fn[1]}\\s*\\(([^)]*)\\)`, 'g');
    for (const cm of text.matchAll(callRe)) {
      // Skip the definition line itself (`(n: number)` matches the pattern).
      const callLine = text.slice(0, cm.index).split('\n').length - 1;
      if (callLine === i) continue;
      sites.push(cm[1]);
    }
    if (sites.length === 0) return false;
    return sites.every((args) => /chunk/i.test(args) || /^\s*\d+\s*$/.test(args));
  }
  return false;
}

/**
 * Per-query placeholder check over a source text: returns one offender
 * string per dynamic `IN (${...})` whose placeholder list is NOT provably
 * bounded. Interpolations that build no `?` placeholders (e.g. literal int
 * lists) are a different defect class and out of scope.
 */
export function findUnboundedInQueries(text: string): string[] {
  const offenders: string[] = [];
  for (const m of text.matchAll(DYNAMIC_IN)) {
    const expr = m[1].trim();
    const line = text.slice(0, m.index).split('\n').length;
    const isBuilder = buildsPlaceholders(expr);
    if (expr.includes('.map(') || expr.includes('Array.from(') || expr.includes('.fill(')) {
      // Inline-built placeholder list: the receiver must be bounded.
      // (`.map(...)` without a `'?'` arrow builds no placeholders.)
      if (!isBuilder) continue;
      const receiver = placeholderReceiver(expr);
      if (receiver == null || !isBoundedReceiver(text, receiver, m.index)) {
        offenders.push(`line ${line}: IN (\${${expr}}) has no bounded receiver`);
      }
      continue;
    }
    if (!new RegExp(`^${IDENT}$`).test(expr)) {
      // Not an identifier and not an inline placeholder builder (e.g. the
      // literal-int lists in export-graph): a different defect class.
      if (!isBuilder) continue;
      offenders.push(`line ${line}: IN (\${${expr}}) is not a resolvable placeholder binding`);
      continue;
    }
    if (BOUNDED_SRC_IDENT.test(expr)) continue;
    // Plain identifier: the NEAREST definition to this query must build its
    // placeholders from a bounded receiver. (A same-named unbounded query
    // elsewhere is still caught by the per-query spread check below, which
    // is positional by construction — the two checks cover each other.)
    const rhs = nearestDef(text, expr, m.index);
    const ok =
      rhs != null &&
      buildsPlaceholders(rhs) &&
      (() => {
        const receiver = placeholderReceiver(rhs);
        return receiver != null && isBoundedReceiver(text, receiver, m.index);
      })();
    if (!ok) {
      offenders.push(
        `line ${line}: IN (\${${expr}}) is not bound to a chunk (.slice-derived) ` +
          `or statically-bounded array in every definition`,
      );
    }
  }
  return offenders;
}

/** Spread identifiers (`...foo`) in a call's argument text. */
function spreadIdents(args: string): string[] {
  // `...foo.bar` / `...foo?.bar` are object spreads inside an argument
  // (e.g. `{ ...p.metadata }`), not array spreads into the call.
  return [...args.matchAll(new RegExp(`\\.\\.\\.(${IDENT})(?![\\w$?.])`, 'g'))].map((m) => m[1]);
}

/** Balanced-paren argument text of a call starting at (line, col of `(`). */
function callArgs(lines: string[], startLine: number, parenCol: number): string {
  let depth = 0;
  let out = '';
  for (let i = startLine; i < Math.min(lines.length, startLine + 12); i++) {
    const chunk = i === startLine ? lines[i].slice(parenCol) : lines[i];
    for (const ch of chunk) {
      out += ch;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return out;
      }
    }
  }
  return out;
}

const CALL_RE = /\.(all|run|get)\s*\(/g;
const CALL_HEAD_RE = new RegExp(`(${IDENT})\\s*\\.\\s*(all|run|get)\\s*\\(`);

/** Template text of the nearest `.prepare(<template>)` above a call line. */
function nearestPrepareTemplate(lines: string[], callLine: number): string | null {
  const from = Math.max(0, callLine - 30);
  for (let i = callLine; i >= from; i--) {
    const idx = lines[i].lastIndexOf('.prepare(');
    if (idx === -1) continue;
    const rest = lines.slice(i, Math.min(lines.length, i + 45)).join('\n');
    const seg = rest.slice(rest.indexOf('.prepare('));
    const open = seg.indexOf('`');
    if (open === -1) return null;
    for (let j = open + 1; j < seg.length; j++) {
      if (seg[j] === '`' && seg[j - 1] !== '\\') return seg.slice(open + 1, j);
    }
    return null;
  }
  return null;
}

/** A single `const|let <name> = <rhs>` definition, if any. */
function singleDef(text: string, name: string): string | null {
  const m = text.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*([^;\\n]+)`));
  return m ? m[1].trim() : null;
}

function isBoundedSpread(text: string, name: string, useIdx: number): boolean {
  if (/^chunk/i.test(name)) return true;
  if (BOUNDED_SRC_IDENT.test(name)) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return true; // fixed const lists
  const def = nearestDef(text, name, useIdx);
  if (def == null) return false;
  if (def.includes('chunk') || def.includes('.slice(')) return true;
  return BOUNDED_SRC_IDENT.test(def);
}

/**
 * Per-query spread check over a source text: returns one offender string
 * per `.all()/.run()/.get()` call that consumes a statement containing a
 * dynamic `IN (${...})` while spreading an unbounded array. Calls chained
 * to statements without a dynamic `IN` (filter-object `...params` shapes)
 * are out of scope — link first, then judge.
 */
export function findUnboundedSpreads(text: string): string[] {
  const offenders: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].trim();
    if (code.startsWith('*') || code.startsWith('//')) continue; // prose
    CALL_RE.lastIndex = 0;
    const cm = CALL_RE.exec(lines[i]);
    if (!cm) continue;
    const template = nearestPrepareTemplate(lines, i);
    let linked = template != null && new RegExp(/IN\s*\(\$\{/).test(template);
    if (!linked) {
      // Statement-builder calls: `buildXStmt(...).run(...)` — the builder
      // template carries the dynamic `IN`. (Plain query-builder functions
      // like `buildSymbolsSearchQuery(...)` return `{ sql, params }` and
      // must NOT link: their spreads are filter values, not id lists.)
      const stmtText = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      if (/build\w*[Ss]tmt\(/.test(stmtText)) {
        linked = true;
      } else {
        const hm = lines[i].match(CALL_HEAD_RE);
        if (hm) {
          const holderIdx = defLine(lines, hm[1]);
          if (holderIdx != null) {
            const holderBlock = lines.slice(holderIdx, holderIdx + 45).join('\n');
            if (/build\w*[Ss]tmt\(/.test(holderBlock)) {
              // Prepared from a statement builder (e.g. file-projection's
              // `symSymStmt`): the builder template holds the dynamic `IN`.
              linked = true;
            } else {
              // Prepared holder: linked only when its own SQL template
              // contains a dynamic `IN` (plain INSERT holders stay out).
              const open = holderBlock.indexOf('`');
              if (open !== -1) {
                for (let j = open + 1; j < holderBlock.length; j++) {
                  if (holderBlock[j] === '`' && holderBlock[j - 1] !== '\\') {
                    if (/IN\s*\(\$\{/.test(holderBlock.slice(open + 1, j))) linked = true;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }
    if (!linked) continue;
    const args = callArgs(lines, i, lines[i].indexOf(cm[0]) + cm[0].length - 1);
    const useIdx = lines.slice(0, i + 1).join('\n').length;
    for (const name of spreadIdents(args)) {
      if (!isBoundedSpread(text, name, useIdx)) {
        offenders.push(
          `line ${i + 1}: .${cm[1]}(...${name}) feeds a dynamic-IN statement with an unbounded array — chunk it`,
        );
      }
    }
  }
  return offenders;
}

describe('no unbounded SQLite IN lists in src/ (TRA-1005)', () => {
  it('every dynamic IN (${...}) is bound to a chunk or a static set (per query)', () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(100); // the walk itself must not silently match nothing

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if ([...text.matchAll(DYNAMIC_IN)].length === 0) continue;

      const exempt = BOUNDED_EXEMPT[file];
      if (exempt) {
        const n = [...text.matchAll(DYNAMIC_IN)].length;
        if (n !== exempt.dynamicInCount) {
          offenders.push(
            `${file}: dynamic IN count changed ${exempt.dynamicInCount} -> ${n} ` +
              `(exempt: ${exempt.reason}). New interpolations need chunking or a new justification.`,
          );
        }
        continue;
      }

      for (const o of findUnboundedInQueries(text)) offenders.push(`${file}:${o}`);
    }

    expect(
      offenders,
      `Unbounded IN lists throw SqliteError past 32 766 variables / RangeError past ~65k ` +
        `spread args (TRA-1005). Bind each query's placeholders to a CHUNK <= 900 slice ` +
        `or a static set:\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('every dynamic-IN statement spreads only bounded arrays (per query)', () => {
    const files = srcFiles();
    const offenders: string[] = [];
    for (const file of files) {
      if (BOUNDED_EXEMPT[file]) continue;
      const text = readFileSync(file, 'utf8');
      for (const o of findUnboundedSpreads(text)) offenders.push(`${file}:${o}`);
    }

    expect(
      offenders,
      `Spreading a full id-array into a dynamic-IN statement throws RangeError past V8's ` +
        `argument ceiling (TRA-1005). Slice into CHUNK <= 900 and spread each chunk:\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('flags an unbounded query next to a bounded one in the same file', () => {
    // Regression for the reviewer's mutation check: reverting ONE query
    // (the parent lookup in `insertSymbols`) to `.all(...unique)` while the
    // file keeps other chunked queries must go red — and must name the
    // unbounded query, not the file.
    const bounded = [
      'const CHUNK = 900;',
      'for (let i = 0; i < ids.length; i += CHUNK) {',
      '  const chunk = ids.slice(i, i + CHUNK);',
      "  const ph = chunk.map(() => '?').join(',');",
      '  const rows = db.prepare(`SELECT * FROM t WHERE id IN (${ph})`).all(...chunk);',
      '}',
    ].join('\n');
    const unbounded = [
      'const unique = [...new Set(parentSymbolIds)];',
      "const placeholders = unique.map(() => '?').join(',');",
      'const rows = db.prepare(`SELECT id FROM s WHERE symbol_id IN (${placeholders})`).all(...unique);',
    ].join('\n');
    const mixed = `${bounded}\n${unbounded}\n`;

    expect(findUnboundedInQueries(bounded)).toEqual([]);
    expect(findUnboundedSpreads(bounded)).toEqual([]);

    const qOff = findUnboundedInQueries(mixed);
    expect(qOff).toHaveLength(1);
    expect(qOff[0]).toMatch(/placeholders/);

    const sOff = findUnboundedSpreads(mixed);
    expect(sOff).toHaveLength(1);
    expect(sOff[0]).toMatch(/unique/);
  });

  it('no whole id-array is spread into .all()/.run()/.get()', () => {
    const files = srcFiles();
    const offenders: string[] = [];
    for (const file of files) {
      if (BOUNDED_EXEMPT[file]) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//')) return; // prose, incl. this rule's own docs
        const m = code.match(BANNED_SPREAD);
        if (m) offenders.push(`${file}:${i + 1}  spreads whole id-array (${m[1]}) — chunk it`);
      });
    }

    expect(
      offenders,
      `Spreading a full id-array into .all()/.run()/.get() throws RangeError past V8's ` +
        `argument ceiling (TRA-1005). Slice into CHUNK <= 900 and spread each chunk:\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('CHUNK sizes stay within the SQLite variable budget', () => {
    const files = srcFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const m of text.matchAll(/const CHUNK\s*=\s*(\d+)/g)) {
        const n = Number(m[1]);
        if (n <= 900) continue;
        // The bound only applies to chunks that feed SQL placeholders —
        // LIMIT/OFFSET pagination chunks (no `.map(() => '?')` nearby) can
        // be larger.
        const matchLine = text.slice(0, m.index).split('\n').length;
        const vicinity = lines.slice(matchLine - 1, matchLine + 40).join('\n');
        if (!/\.map\(\(\) => '\?'\)/.test(vicinity)) continue;
        offenders.push(`${file}:${matchLine}  CHUNK = ${n} exceeds 900`);
      }
    }

    expect(
      offenders,
      `CHUNK must stay <= 900 so even double-fed statements (2x placeholders, ` +
        `cf. graph-repository CHUNK = 450) sit far under SQLITE_MAX_VARIABLE_NUMBER (32766):\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('chunk results accumulate with a loop, never push(...rows)', () => {
    const files = srcFiles().filter((f) => f.startsWith('src/indexer/') || f.startsWith('src/db/'));
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//')) return;
        if (BANNED_RESULT_SPREAD.test(code)) offenders.push(`${file}:${i + 1}  ${code}`);
      });
    }

    expect(
      offenders,
      `push(...rows) spreads through Function.apply and reintroduces the V8 ceiling ` +
        `the chunking removed (TRA-1005). Accumulate with a loop instead:\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('path keys are Windows-proof (TRA-1804)', () => {
    // Every BOUNDED_EXEMPT key must be written with `/` so it matches the
    // normalized walk output, and a simulated Windows path must resolve to
    // the same key — otherwise windows-latest flags exempt files again.
    for (const key of Object.keys(BOUNDED_EXEMPT)) {
      expect(key).not.toMatch(/\\/);
      expect(BOUNDED_EXEMPT[norm(key.replace(/\//g, '\\'))]).toBeDefined();
    }
    expect(norm('src\\indexer\\edge-resolver.ts').startsWith('src/indexer/')).toBe(true);
  });
});
