/**
 * `get_suggested_questions` — auto-generated, prioritized review questions
 * derived from the analyses we already compute.
 *
 * Borrowed from CRG v2.3.2 (`get_suggested_questions_tool`). Reviewers
 * usually need to focus on the same recurring concerns: which changed
 * symbols carry high blast radius, which untested files were touched,
 * which dead/duplicate symbols are growing, which framework entry points
 * lack a corresponding test. Computing those signals one-by-one and
 * eyeballing them is exactly the work an agent should do.
 *
 * The tool aggregates already-cached results (no fresh git/embedding
 * work) and ranks the candidate questions by blast severity. Output is
 * a short ranked list — each question has the tool the user should
 * follow up with, the suggested arguments, and a one-line "why this
 * matters" hint.
 */
import type { Store } from '../../db/store.js';

export interface SuggestedQuestion {
  /** Stable identifier for the question template — useful for filtering. */
  id: string;
  /** Severity bucket. high = blocking before merge, medium = should review,
   * low = note for follow-up. */
  severity: 'high' | 'medium' | 'low';
  /** Short, single-sentence question phrased for a reviewer. */
  question: string;
  /** Why this question was generated — names the symbol/file/metric. */
  reason: string;
  /** Tool the reviewer should run to answer it. */
  follow_up: { tool: string; args?: Record<string, unknown> };
}

export interface SuggestedQuestionsResult {
  questions: SuggestedQuestion[];
  total: number;
  generated_at: string;
}

interface SymbolMetaRow {
  symbol_id: string;
  name: string;
  file_path: string;
  metadata: string | null;
}

const QUESTION_LIMIT = 12;

export function getSuggestedQuestions(store: Store): SuggestedQuestionsResult {
  const questions: SuggestedQuestion[] = [];

  // ── 1. Framework entry points without an obvious test partner ────────────
  // Controllers/services/repositories carry the same false-positive risk as
  // dead-code analysis: they're framework-managed entry points. If there's
  // no matching test file, the reviewer should know.
  const fwSymbols = store.db
    .prepare(`
    SELECT s.symbol_id, s.name, f.path AS file_path, s.metadata
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.metadata IS NOT NULL
      AND (
        json_extract(s.metadata, '$.frameworkRole') IS NOT NULL
        OR json_extract(s.metadata, '$.decorators') IS NOT NULL
        OR json_extract(s.metadata, '$.annotations') IS NOT NULL
      )
      AND s.kind IN ('class', 'function')
    LIMIT 200
  `)
    .all() as SymbolMetaRow[];

  let untested = 0;
  for (const row of fwSymbols) {
    const testGlob = guessTestGlobs(row.file_path, row.name);
    const hasTest = testGlob.some((g) => {
      const probe = store.db.prepare('SELECT 1 FROM files WHERE path GLOB ? LIMIT 1').get(g) as
        | { 1: number }
        | undefined;
      return Boolean(probe);
    });
    if (!hasTest) {
      untested++;
      if (untested <= 3) {
        questions.push({
          id: 'untested_framework_entry_point',
          severity: 'high',
          question: `Is "${row.name}" exercised by an integration or unit test?`,
          reason: `${row.file_path} declares a framework entry point (controller/service/handler) with no obvious test file partner.`,
          follow_up: { tool: 'get_tests_for', args: { symbol_id: row.symbol_id } },
        });
      }
    }
  }
  if (untested > 3) {
    questions.push({
      id: 'untested_framework_entry_point_summary',
      severity: 'medium',
      question: `Should the team triage the ${untested - 3} additional untested framework entry points?`,
      reason: `${untested} entry points lack an obvious test file. Showing the first 3 above.`,
      follow_up: { tool: 'get_untested_exports', args: {} },
    });
  }

  // ── 2. Circular imports — defer to the on-demand tool ───────────────────
  // We don't cache cycles in the DB. The question still belongs in the
  // canned list because cycle hunting is a recurring review task.
  questions.push({
    id: 'circular_imports',
    severity: 'medium',
    question: 'Are there any circular import chains in the changed surface?',
    reason:
      'Circular imports inflate cold-start time and break tree-shaking; if accidental they should be broken with an interface or DI.',
    follow_up: { tool: 'get_circular_imports' },
  });

  // ── 3. Symbol duplication clusters — defer to detect_ast_clones ─────────
  // ast clones aren't cached in a table; suggest running the tool.
  questions.push({
    id: 'ast_clone_cluster',
    severity: 'medium',
    question: 'Have any structural clones (Type-2) appeared on this branch?',
    reason:
      'Type-2 clones share an AST shape after identifier/literal normalisation — the prime DRY-refactor candidates.',
    follow_up: { tool: 'detect_ast_clones' },
  });

  // ── 4. High-confidence dead exports (post-framework-aware filter) ───────
  // Use the same JSON-extract trick as the dead-code module to count
  // unreferenced exports. Safe even if the dead_code_v2 cache isn't built.
  const exportedCount = store.db
    .prepare(`
    SELECT COUNT(*) AS cnt
    FROM symbols s
    WHERE json_extract(s.metadata, '$.exported') = 1
      AND s.kind != 'method'
  `)
    .get() as { cnt: number };
  if (exportedCount.cnt > 50) {
    questions.push({
      id: 'dead_export_audit',
      severity: 'low',
      question: `Are all ${exportedCount.cnt} exports actually consumed, or has the public surface drifted?`,
      reason:
        'Public APIs accrete over time; a periodic dead-export audit catches code that should have been deleted in a prior PR.',
      follow_up: { tool: 'get_dead_exports' },
    });
  }

  // ── 5. Untested-but-exported symbols ────────────────────────────────────
  // Different signal from #1: this catches plain exports without test
  // coverage, not specifically framework entry points.
  // (Cheaper than running get_untested_symbols inline; we just ask the
  // question if the project has any test files at all.)
  const hasTests = store.db
    .prepare("SELECT 1 FROM files WHERE path LIKE '%.test.%' OR path LIKE '%/__tests__/%' LIMIT 1")
    .get();
  if (hasTests) {
    questions.push({
      id: 'untested_symbols',
      severity: 'medium',
      question: 'Which exported symbols have no test coverage at all (vs imported-but-not-called)?',
      reason:
        'get_untested_symbols classifies "unreached" vs "imported_not_called" — the unreached set is the highest-leverage place to add tests.',
      follow_up: { tool: 'get_untested_symbols' },
    });
  }

  // Sort: severity desc, then by id for stable output.
  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  questions.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    questions: questions.slice(0, QUESTION_LIMIT),
    total: questions.length,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Best-effort test-file globbing: for `src/auth/Service.ts` we probe
 * `tests/auth/Service.test.ts`, `src/auth/Service.test.ts`, and similar.
 * Doesn't try to be exhaustive — it's just enough to flip "has any test
 * partner" to true on real-world test layouts.
 */
function guessTestGlobs(filePath: string, _symbolName: string): string[] {
  const segments = filePath.split('/');
  const basename = segments[segments.length - 1];
  const stem = basename.replace(/\.[^.]+$/, '');
  return [
    filePath.replace(/\.([jt]sx?|py|java|kt|rb|go|rs)$/, '.test.$1'),
    filePath.replace(/\.([jt]sx?|py|java|kt|rb|go|rs)$/, '.spec.$1'),
    `**/__tests__/**/${stem}*`,
    `tests/**/${stem}*`,
    `**/*${stem}.test.*`,
    `**/*${stem}.spec.*`,
    `**/test_${stem}.py`,
  ];
}
