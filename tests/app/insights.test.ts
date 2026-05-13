/**
 * Smoke test for the Insights tab.
 *
 * The Electron app package has no React/jsdom test harness, so this test
 * targets the pure logic exported from insights-runtime.ts: the report
 * catalog, JSON-RPC envelope shaping, and per-report row flatteners.
 * The React component itself is exercised by manual launch.
 *
 * IMPORTANT: this file imports ONLY from insights-runtime.ts — NEVER from
 * Insights.tsx — to keep React out of the test graph (frozen-lockfile
 * hoisting on CI does not place `react` in the root node_modules).
 */
import { describe, expect, it } from 'vitest';
import {
  INSIGHT_REPORTS,
  REPORT_BY_ID,
  buildRpcCall,
  flattenDriftRows,
  flattenPagerankRows,
  flattenRiskHotspotRows,
  flattenReport,
} from '../../packages/app/src/renderer/tabs/insights-runtime';

describe('Insights tab', () => {
  describe('report catalog', () => {
    it('exposes exactly the three slice-1 reports', () => {
      const ids = INSIGHT_REPORTS.map((r) => r.id).sort();
      expect(ids).toEqual(['claudemd_drift', 'pagerank', 'risk_hotspots']);
    });

    it('every report has a non-empty title, description, and tool name', () => {
      for (const r of INSIGHT_REPORTS) {
        expect(r.title.length).toBeGreaterThan(0);
        expect(r.description.length).toBeGreaterThan(0);
        expect(r.mcpTool.length).toBeGreaterThan(0);
      }
    });

    it('maps each id to the correct MCP tool', () => {
      expect(REPORT_BY_ID.claudemd_drift.mcpTool).toBe('check_claudemd_drift');
      expect(REPORT_BY_ID.pagerank.mcpTool).toBe('get_pagerank');
      expect(REPORT_BY_ID.risk_hotspots.mcpTool).toBe('get_risk_hotspots');
    });
  });

  describe('buildRpcCall', () => {
    it('shapes a JSON-RPC tools/call envelope for check_claudemd_drift', () => {
      const env = buildRpcCall('claudemd_drift', '/my/project');
      expect(env.jsonrpc).toBe('2.0');
      expect(env.method).toBe('tools/call');
      expect(env.params.name).toBe('check_claudemd_drift');
      expect(env.params.arguments).toEqual({});
    });

    it('shapes a JSON-RPC envelope for get_pagerank with a limit argument', () => {
      const env = buildRpcCall('pagerank', '/my/project');
      expect(env.params.name).toBe('get_pagerank');
      expect(env.params.arguments).toEqual({ limit: 20 });
    });

    it('shapes a JSON-RPC envelope for get_risk_hotspots with a limit argument', () => {
      const env = buildRpcCall('risk_hotspots', '/my/project');
      expect(env.params.name).toBe('get_risk_hotspots');
      expect(env.params.arguments).toEqual({ limit: 20 });
    });

    it('honours a custom request id', () => {
      const env = buildRpcCall('pagerank', '/p', 99);
      expect(env.id).toBe(99);
    });
  });

  describe('flattenDriftRows', () => {
    it('flattens { issues: [...] } into uniform rows with severity badges', () => {
      const out = flattenDriftRows({
        total: 2,
        issues: [
          {
            file: 'CLAUDE.md',
            line: 12,
            category: 'dead_path',
            issue: 'src/old.ts no longer exists',
            severity: 'high',
            fix: 'Remove the reference',
          },
          {
            file: 'CLAUDE.md',
            line: 88,
            category: 'stale_symbol',
            issue: 'registerTool renamed to addTool',
            severity: 'medium',
          },
        ],
      });
      expect(out.rows).toHaveLength(2);
      expect(out.rows[0].primary).toContain('CLAUDE.md:12');
      expect(out.rows[0].primary).toContain('src/old.ts no longer exists');
      expect(out.rows[0].badge).toBe('high');
      expect(out.rows[0].secondary).toBe('Fix: Remove the reference');
      expect(out.rows[1].badge).toBe('medium');
      expect(out.rows[1].secondary).toBe('stale_symbol');
    });

    it('returns an empty rows array when the payload is missing or malformed', () => {
      expect(flattenDriftRows(null).rows).toEqual([]);
      expect(flattenDriftRows({}).rows).toEqual([]);
      expect(flattenDriftRows({ issues: 'not-an-array' }).rows).toEqual([]);
    });
  });

  describe('flattenPagerankRows', () => {
    it('flattens a bare array of { file, score } into rows', () => {
      const out = flattenPagerankRows([
        { file: 'src/server.ts', score: 0.12345 },
        { file: 'src/store.ts', score: 0.09876 },
      ]);
      expect(out.rows).toHaveLength(2);
      expect(out.rows[0].primary).toBe('src/server.ts');
      expect(out.rows[0].badge).toBe('0.123');
      expect(out.rows[0].secondary).toBe('score 0.1235');
    });

    it('also accepts { items: [...] } envelope shape', () => {
      const out = flattenPagerankRows({
        items: [{ file: 'src/foo.ts', score: 0.5 }],
      });
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0].primary).toBe('src/foo.ts');
    });
  });

  describe('flattenRiskHotspotRows', () => {
    it('flattens { hotspots: [...] } including confidence in secondary', () => {
      const out = flattenRiskHotspotRows({
        total: 1,
        hotspots: [
          {
            file: 'src/big-file.ts',
            score: 42.7,
            complexity: 18,
            commits: 25,
            confidence_level: 'multi_signal',
          },
        ],
      });
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0].primary).toBe('src/big-file.ts');
      expect(out.rows[0].secondary).toBe('complexity 18 · 25 commits · multi_signal');
      expect(out.rows[0].badge).toBe('42.7');
    });

    it('returns empty rows when payload has no hotspots', () => {
      expect(flattenRiskHotspotRows({}).rows).toEqual([]);
      expect(flattenRiskHotspotRows(null).rows).toEqual([]);
    });
  });

  describe('flattenReport', () => {
    it('dispatches to the right flattener per report id', () => {
      const drift = flattenReport('claudemd_drift', {
        issues: [{ issue: 'x', file: 'a', line: 1 }],
      });
      expect(drift.rows).toHaveLength(1);
      const pr = flattenReport('pagerank', [{ file: 'src/a.ts', score: 0.1 }]);
      expect(pr.rows).toHaveLength(1);
      const rh = flattenReport('risk_hotspots', { hotspots: [{ file: 'src/b.ts', score: 1 }] });
      expect(rh.rows).toHaveLength(1);
    });
  });
});
