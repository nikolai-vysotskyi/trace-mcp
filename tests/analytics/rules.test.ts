import { describe, expect, it } from 'vitest';
import type { ToolCallRow } from '../../src/analytics/analytics-store.js';
import { analyzeOptimizations } from '../../src/analytics/rules.js';

function makeToolCall(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    tool_name: 'Read',
    tool_server: 'builtin',
    tool_short_name: 'Read',
    output_size_chars: 1000,
    output_tokens_estimate: 286, // ~1000/3.5
    target_file: 'src/foo.ts',
    is_error: 0,
    session_id: 'sess-001',
    input_snippet: null,
    semantic_degraded: 0,
    ...overrides,
  };
}

/** Build a `search` ToolCallRow with query + semantic mode captured in input_snippet,
 *  matching what AnalyticsStore.storeSession now writes for search calls. */
function makeSearchCall(query: string, overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return makeToolCall({
    tool_name: 'mcp__trace-mcp__search',
    tool_server: 'trace-mcp',
    tool_short_name: 'search',
    target_file: null,
    input_snippet: JSON.stringify({ query, semantic: 'on' }),
    output_tokens_estimate: 200,
    ...overrides,
  });
}

describe('rules / analyzeOptimizations', () => {
  it('returns empty optimizations for empty tool calls', () => {
    const report = analyzeOptimizations([], 'all');
    expect(report.optimizations).toEqual([]);
    expect(report.totalPotentialSavings.tokens).toBe(0);
    expect(report.period).toBe('all');
  });

  describe('repeated-file-read rule', () => {
    it('detects same file read 3+ times in one session', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({ target_file: 'src/big.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/big.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/big.ts', output_tokens_estimate: 500 }),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'repeated-file-read');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('high');
      expect(hit!.occurrences).toBe(3);
      expect(hit!.currentTokens).toBe(1500);
      expect(hit!.potentialTokens).toBe(300); // 20% of 1500
    });

    it('does not trigger for only 2 reads of same file', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({ target_file: 'src/small.ts' }),
        makeToolCall({ target_file: 'src/small.ts' }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'repeated-file-read');
      expect(hit).toBeUndefined();
    });

    it('does not trigger for binary files read repeatedly', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({ target_file: 'assets/screenshot.png', output_tokens_estimate: 2000 }),
        makeToolCall({ target_file: 'assets/screenshot.png', output_tokens_estimate: 2000 }),
        makeToolCall({ target_file: 'assets/screenshot.png', output_tokens_estimate: 2000 }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'repeated-file-read');
      expect(hit).toBeUndefined();
    });
  });

  describe('bash-grep rule', () => {
    it('detects Bash calls with grep/rg commands', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          tool_server: 'builtin',
          target_file: null,
          input_snippet: 'grep -r "parseToolName" src/',
          output_tokens_estimate: 1000,
        }),
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          tool_server: 'builtin',
          target_file: null,
          input_snippet: 'rg "function" --type ts',
          output_tokens_estimate: 800,
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-grep');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('high');
      expect(hit!.occurrences).toBe(2);
      expect(hit!.currentTokens).toBe(1800);
    });

    it('does not trigger for Bash calls without grep', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'npm test',
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-grep');
      expect(hit).toBeUndefined();
    });

    it('does not trigger for stream pipe filters (e.g. ps aux | grep node)', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'ps aux | grep node',
        }),
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'git status | grep modified',
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-grep');
      expect(hit).toBeUndefined();
    });
  });

  describe('bash-cat rule', () => {
    it('detects Bash calls with cat/head/tail on real files', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'cat src/server.ts',
          target_file: 'src/server.ts',
          output_tokens_estimate: 800,
        }),
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'head -n 50 package.json',
          target_file: 'package.json',
          output_tokens_estimate: 400,
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-cat');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('medium');
      expect(hit!.occurrences).toBe(2);
      expect(hit!.currentTokens).toBe(1200);
      expect(hit!.potentialTokens).toBe(480); // 40% of 1200
    });

    it('does not trigger for pipeline output filters or truncations (e.g. git log | head)', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'git log --oneline | head -n 20',
          target_file: null,
        }),
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'multica issue list | head -n 5',
          target_file: null,
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-cat');
      expect(hit).toBeUndefined();
    });

    it('does not trigger for heredocs (cat << "EOF")', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'cat << \'EOF\' > config.json\n{"foo": "bar"}\nEOF',
          target_file: null,
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-cat');
      expect(hit).toBeUndefined();
    });

    it('does not trigger for binary files (e.g. cat image.png)', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'cat assets/logo.png',
          target_file: 'assets/logo.png',
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-cat');
      expect(hit).toBeUndefined();
    });
  });

  describe('large-file-read rule', () => {
    it('detects Read with output > 5000 chars', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          output_size_chars: 8000,
          output_tokens_estimate: 2286,
          target_file: 'src/huge-file.ts',
        }),
        makeToolCall({
          output_size_chars: 6000,
          output_tokens_estimate: 1714,
          target_file: 'src/another-big.ts',
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'large-file-read');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('medium');
      expect(hit!.occurrences).toBe(2);
      expect(hit!.currentTokens).toBe(4000);
      expect(hit!.potentialTokens).toBe(600); // 15% of 4000
    });

    it('does not trigger for small file reads', () => {
      const calls: ToolCallRow[] = [makeToolCall({ output_size_chars: 2000 })];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'large-file-read');
      expect(hit).toBeUndefined();
    });

    it('does not trigger for large binary files', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          output_size_chars: 12000,
          output_tokens_estimate: 3428,
          target_file: 'assets/screenshot.png',
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'large-file-read');
      expect(hit).toBeUndefined();
    });
  });

  describe('report structure', () => {
    it('has correct structure with period and current usage', () => {
      const calls: ToolCallRow[] = [makeToolCall({ output_tokens_estimate: 500 })];

      const report = analyzeOptimizations(calls, 'month');
      expect(report.period).toBe('month');
      expect(report.currentUsage.totalTokens).toBe(500);
      expect(report.currentUsage.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      expect(report.totalPotentialSavings).toHaveProperty('tokens');
      expect(report.totalPotentialSavings).toHaveProperty('costUsd');
      expect(report.totalPotentialSavings).toHaveProperty('pct');
    });

    it('sorts optimizations by severity (high first)', () => {
      // Create calls that trigger both high (repeated-file-read) and medium (large-file-read) rules
      const calls: ToolCallRow[] = [
        // repeated-file-read (high)
        makeToolCall({ target_file: 'src/x.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/x.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/x.ts', output_tokens_estimate: 500 }),
        // large-file-read (medium)
        makeToolCall({
          target_file: 'src/big.ts',
          output_size_chars: 10000,
          output_tokens_estimate: 2857,
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      expect(report.optimizations.length).toBeGreaterThanOrEqual(2);

      const severities = report.optimizations.map((o) => o.severity);
      const highIdx = severities.indexOf('high');
      const mediumIdx = severities.indexOf('medium');
      if (highIdx >= 0 && mediumIdx >= 0) {
        expect(highIdx).toBeLessThan(mediumIdx);
      }
    });
  });

  // TRA-1514: agent-for-indexed used to book 50K unmeasured tokens per Agent
  // call as currentTokens, so 56 real calls (14,210 measured tokens) claimed
  // 2.8M current tokens and pushed the whole report past 100% savings.
  describe('agent-for-indexed rule', () => {
    it('books measured output tokens, not an estimated constant', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Agent',
          tool_server: 'builtin',
          tool_short_name: 'Agent',
          target_file: null,
          output_tokens_estimate: 254,
        }),
        makeToolCall({
          tool_name: 'Agent',
          tool_server: 'builtin',
          tool_short_name: 'Agent',
          target_file: null,
          output_tokens_estimate: 254,
        }),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'agent-for-indexed');
      expect(hit).toBeDefined();
      expect(hit!.occurrences).toBe(2);
      expect(hit!.currentTokens).toBe(508);
      expect(hit!.currentTokens).toBeLessThan(2 * 50000);
    });

    it('never reports more than 100% total savings', () => {
      const calls: ToolCallRow[] = [];
      for (let i = 0; i < 56; i++) {
        calls.push(
          makeToolCall({
            tool_name: 'Agent',
            tool_server: 'builtin',
            tool_short_name: 'Agent',
            target_file: null,
            output_tokens_estimate: 254,
          }),
        );
      }

      const report = analyzeOptimizations(calls, 'week');
      expect(report.totalPotentialSavings.pct).toBeLessThanOrEqual(100);
    });
  });

  // TRA-641: unused-trace-tools decides "did this session use trace-mcp?"
  // by matching tool_server. After the trace-mcp -> trace rename (TRA-611/
  // 614), a migrated client logs tool_server: "trace" instead of
  // "trace-mcp"/"trace_mcp" -- this must still count as trace-mcp usage, or
  // every migrated session's nav calls (Read/Grep/Glob) get wrongly flagged
  // as "trace-mcp tools available but never called".
  describe('unused-trace-tools rule', () => {
    const traceServerSpellings = ['trace', 'trace-mcp', 'trace_mcp'] as const;

    for (const server of traceServerSpellings) {
      it(`recognizes tool_server="${server}" as trace-mcp usage -- nav calls are not flagged`, () => {
        const calls: ToolCallRow[] = [
          makeToolCall({
            tool_name: `mcp__${server}__search`,
            tool_server: server,
            tool_short_name: 'search',
            target_file: null,
          }),
          makeToolCall({ tool_name: 'Read', tool_short_name: 'Read', tool_server: 'builtin' }),
          makeToolCall({ tool_name: 'Read', tool_short_name: 'Read', tool_server: 'builtin' }),
        ];

        const report = analyzeOptimizations(calls, 'all');
        const hit = report.optimizations.find((o) => o.rule === 'unused-trace-tools');
        expect(hit).toBeUndefined();
      });
    }

    it('flags a session that only uses nav tools with no recognized trace-mcp call', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({ tool_name: 'Read', tool_short_name: 'Read', tool_server: 'builtin' }),
        makeToolCall({ tool_name: 'Read', tool_short_name: 'Read', tool_server: 'builtin' }),
        makeToolCall({ tool_name: 'Grep', tool_short_name: 'Grep', tool_server: 'builtin' }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'unused-trace-tools');
      expect(hit).toBeDefined();
    });
  });

  describe('semantic-degraded-no-provider rule', () => {
    it('detects search calls whose semantic request silently fell back to lexical', () => {
      const calls: ToolCallRow[] = [
        makeSearchCall('authenticate user', { semantic_degraded: 1 }),
        makeSearchCall('parse config file', { semantic_degraded: 1 }),
        makeSearchCall('unrelated lexical search', { semantic_degraded: 0 }),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'semantic-degraded-no-provider');
      expect(hit).toBeDefined();
      expect(hit!.occurrences).toBe(2);
      expect(hit!.recommendation).toMatch(/embed_repo|AI provider/);
      expect(hit!.recommendation).toContain('semantic');
    });

    it('does not trigger when no search calls were degraded', () => {
      const calls: ToolCallRow[] = [
        makeSearchCall('authenticate user', { semantic_degraded: 0 }),
        makeToolCall(),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'semantic-degraded-no-provider');
      expect(hit).toBeUndefined();
    });

    it('does not trigger for non-search tools even if the flag were somehow set', () => {
      const calls: ToolCallRow[] = [makeToolCall({ semantic_degraded: 1 })];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'semantic-degraded-no-provider');
      expect(hit).toBeUndefined();
    });
  });

  describe('possible-duplicate-semantic-search rule', () => {
    it('flags two semantic searches sharing 2+ significant keywords within a short window', () => {
      const calls: ToolCallRow[] = [
        makeSearchCall('authenticate user'),
        makeToolCall({ target_file: 'src/unrelated.ts' }),
        makeSearchCall('user authentication logic'),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'possible-duplicate-semantic-search');
      expect(hit).toBeDefined();
      expect(hit!.occurrences).toBeGreaterThanOrEqual(1);
      expect(hit!.recommendation.length).toBeGreaterThan(0);
    });

    it('does not flag semantic searches sharing fewer than 2 significant keywords', () => {
      const calls: ToolCallRow[] = [
        makeSearchCall('authenticate user'),
        makeSearchCall('render dashboard widget'),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'possible-duplicate-semantic-search');
      expect(hit).toBeUndefined();
    });

    it('does not flag near-duplicate queries that are far apart in the same session', () => {
      // Same 2 overlapping keywords, but separated by many intervening calls —
      // outside the "short window" — should not be flagged as a near-duplicate.
      const filler = Array.from({ length: 20 }, (_, i) =>
        makeToolCall({ target_file: `src/filler${i}.ts` }),
      );
      const calls: ToolCallRow[] = [
        makeSearchCall('authenticate user'),
        ...filler,
        makeSearchCall('user authentication logic'),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'possible-duplicate-semantic-search');
      expect(hit).toBeUndefined();
    });

    it('does not flag non-semantic (lexical-only) repeated searches', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'mcp__trace-mcp__search',
          tool_server: 'trace-mcp',
          tool_short_name: 'search',
          input_snippet: JSON.stringify({ query: 'authenticate user', semantic: null }),
        }),
        makeToolCall({
          tool_name: 'mcp__trace-mcp__search',
          tool_server: 'trace-mcp',
          tool_short_name: 'search',
          input_snippet: JSON.stringify({ query: 'user authentication logic', semantic: null }),
        }),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'possible-duplicate-semantic-search');
      expect(hit).toBeUndefined();
    });

    it('does not flag a single semantic search with no companion', () => {
      const calls: ToolCallRow[] = [makeSearchCall('authenticate user')];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'possible-duplicate-semantic-search');
      expect(hit).toBeUndefined();
    });
  });

  describe('identical-error-retry rule', () => {
    it('detects 6 identical error calls while ignoring 1 successful call (occurrences=6)', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'php -l app/Nova/Dashboards/Main.php',
          is_error: 0,
          output_tokens_estimate: 50,
        }),
        ...Array.from({ length: 6 }, () =>
          makeToolCall({
            tool_name: 'Bash',
            tool_short_name: 'Bash',
            input_snippet: 'php -l app/Nova/Dashboards/Main.php',
            is_error: 1,
            output_tokens_estimate: 100,
          }),
        ),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'identical-error-retry');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('medium');
      expect(hit!.occurrences).toBe(6);
      expect(hit!.currentTokens).toBe(600);
      expect(hit!.potentialTokens).toBe(100);
      expect(hit!.details[0]).toContain(
        'Bash "php -l app/Nova/Dashboards/Main.php" (6x failed, ~600 tokens)',
      );
      expect(hit!.recommendation).toContain('repeating failing commands');
    });

    it('does not trigger when errors have different input snippets', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({ tool_short_name: 'Bash', input_snippet: 'php -l file1.php', is_error: 1 }),
        makeToolCall({ tool_short_name: 'Bash', input_snippet: 'php -l file2.php', is_error: 1 }),
        makeToolCall({ tool_short_name: 'Bash', input_snippet: 'php -l file3.php', is_error: 1 }),
        makeToolCall({ tool_short_name: 'Bash', input_snippet: 'php -l file4.php', is_error: 1 }),
        makeToolCall({ tool_short_name: 'Bash', input_snippet: 'php -l file5.php', is_error: 1 }),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'identical-error-retry');
      expect(hit).toBeUndefined();
    });

    it('does not trigger for 4 identical error calls (threshold is 5)', () => {
      const calls: ToolCallRow[] = Array.from({ length: 4 }, () =>
        makeToolCall({
          tool_short_name: 'Bash',
          input_snippet: 'php artisan tinker',
          is_error: 1,
        }),
      );

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'identical-error-retry');
      expect(hit).toBeUndefined();
    });

    it('triggers high severity when occurrences reaches 50', () => {
      const calls: ToolCallRow[] = Array.from({ length: 50 }, () =>
        makeToolCall({
          tool_short_name: 'Bash',
          input_snippet: 'php artisan tinker --execute "test()"',
          is_error: 1,
          output_tokens_estimate: 10,
        }),
      );

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'identical-error-retry');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('high');
      expect(hit!.occurrences).toBe(50);
      expect(hit!.currentTokens).toBe(500);
      expect(hit!.potentialTokens).toBe(10);
    });

    it('does not trigger when input_snippet is missing or whitespace only', () => {
      const calls: ToolCallRow[] = [
        ...Array.from({ length: 5 }, () =>
          makeToolCall({ tool_short_name: 'Bash', input_snippet: null, is_error: 1 }),
        ),
        ...Array.from({ length: 5 }, () =>
          makeToolCall({ tool_short_name: 'Bash', input_snippet: '   ', is_error: 1 }),
        ),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'identical-error-retry');
      expect(hit).toBeUndefined();
    });

    it('does not aggregate identical calls across different sessions below threshold', () => {
      const calls: ToolCallRow[] = [
        ...Array.from({ length: 3 }, () =>
          makeToolCall({
            session_id: 'sess-A',
            tool_short_name: 'Bash',
            input_snippet: 'npm test',
            is_error: 1,
          }),
        ),
        ...Array.from({ length: 3 }, () =>
          makeToolCall({
            session_id: 'sess-B',
            tool_short_name: 'Bash',
            input_snippet: 'npm test',
            is_error: 1,
          }),
        ),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'identical-error-retry');
      expect(hit).toBeUndefined();
    });

    it('correctly models TRA-1808 multi-session retry storms at scale (325x + 499x)', () => {
      const sess1Calls = Array.from({ length: 325 }, () =>
        makeToolCall({
          session_id: 'b04468dd-32d8-4d22-a940-75da74e2d5ff',
          tool_short_name: 'Bash',
          input_snippet: 'php -l app/Nova/Dashboards/Main.php && php -l ...',
          is_error: 1,
          output_tokens_estimate: 20,
        }),
      );
      const sess2Calls = Array.from({ length: 499 }, () =>
        makeToolCall({
          session_id: '173cb6db-538d-40c9-ac75-9e8d56e9cb60',
          tool_short_name: 'Bash',
          input_snippet: "php artisan tinker --execute '...'",
          is_error: 1,
          output_tokens_estimate: 15,
        }),
      );

      const report = analyzeOptimizations([...sess1Calls, ...sess2Calls], 'week');
      const hit = report.optimizations.find((o) => o.rule === 'identical-error-retry');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('high');
      expect(hit!.occurrences).toBe(824); // 325 + 499
      expect(hit!.currentTokens).toBe(325 * 20 + 499 * 15); // 6500 + 7485 = 13985
      // 1 legitimate first attempt per session group (20 + 15 = 35)
      expect(hit!.potentialTokens).toBe(20 + 15);
      // Saved tokens equals all wasteful retries (324 * 20 + 498 * 15 = 6480 + 7470 = 13950)
      expect(hit!.currentTokens - hit!.potentialTokens).toBe(324 * 20 + 498 * 15);
      expect(report.totalPotentialSavings.pct).toBeLessThanOrEqual(100);
    });
  });
});
