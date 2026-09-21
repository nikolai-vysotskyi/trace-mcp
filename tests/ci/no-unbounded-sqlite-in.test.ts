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
 * The rule: every dynamic `IN (${...})` in `src/` must either be built from
 * a chunk (`chunk.map(() => '?')`, i.e. the file carries a chunk loop), be
 * tied to a statically-bounded set (edge-type names, HTTP methods, symbol
 * kinds, language lists — dozens of elements by construction), or be listed
 * in BOUNDED_EXEMPT with a frozen interpolation count and a justification.
 * Whole id-arrays must never be spread into `.all()/.run()/.get()`, and
 * chunk results accumulate with a loop (`for (const r of rows) out.push(r)`)
 * because `push(...rows)` spreads through Function.apply and blows the
 * stack itself at a few hundred thousand rows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DYNAMIC_IN = /IN\s*\(\$\{([^}]+)\}\)/g;

// Interpolations built from these identifiers are bounded by schema or by
// a fixed literal list (edge-type names, HTTP verbs, symbol kinds, language
// tuples, small exclusion sets) — they cannot grow with the index.
const STATIC_SAFE =
  /\b(TS_JS_LANGS|HTTP_METHODS|httpMethods|MARKDOWN_[A-Z_]+|excluded\w*|kinds|edgeTypeNames|ALLOWED_\w+)\b/;

// A file carrying one of these chunks its dynamic lists.
const CHUNK_MARKER = /const CHUNK\s*=\s*\d+|\.slice\(/;

// Whole-array variable names that must never be spread into a single
// `.all()/.run()/.get()` call — each is an index-sized id list (scoped file
// ids, symbol/node id batches). After chunking, only `...chunk`-style
// (bounded) spreads remain.
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

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk('src');
  return out;
}

describe('no unbounded SQLite IN lists in src/ (TRA-1005)', () => {
  it('every dynamic IN (${...}) is chunked, statically bounded, or exempt', () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(100); // the walk itself must not silently match nothing

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const matches = [...text.matchAll(DYNAMIC_IN)];
      if (matches.length === 0) continue;

      const exempt = BOUNDED_EXEMPT[file];
      if (exempt) {
        if (matches.length !== exempt.dynamicInCount) {
          offenders.push(
            `${file}: dynamic IN count changed ${exempt.dynamicInCount} -> ${matches.length} ` +
              `(exempt: ${exempt.reason}). New interpolations need chunking or a new justification.`,
          );
        }
        continue;
      }

      const chunked = CHUNK_MARKER.test(text);
      const lines = text.split('\n');
      for (const m of matches) {
        const expr = m[1].trim();
        if (STATIC_SAFE.test(expr)) continue;
        // `placeholders` built from a static set a few lines above
        // (e.g. `const placeholders = httpMethods.map(...)`) is static too.
        const matchLine = text.slice(0, m.index).split('\n').length;
        const above = lines.slice(Math.max(0, matchLine - 13), matchLine - 1).join('\n');
        if (STATIC_SAFE.test(above) && /\.map\(\(\) => '\?'\)/.test(above)) continue;
        if (chunked) continue;
        offenders.push(
          `${file}:${matchLine}  IN (\${${expr}}) is neither chunked nor statically bounded`,
        );
      }
    }

    expect(
      offenders,
      `Unbounded IN lists throw SqliteError past 32 766 variables / RangeError past ~65k ` +
        `spread args (TRA-1005). Chunk the list (CHUNK <= 900, loop-push the rows) or tie it ` +
        `to a static set:\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
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
});
