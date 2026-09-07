/**
 * TRA-1072: `syncProjectAnalytics()` must report the machine-wide newest
 * session log mtime, not just the mtime of the requested project's own
 * logs. Before this fix, a project with no session logs of its own got
 * `newest_log_mtime: null` from its scoped sync, and `buildIngestionStatus`
 * turned that into `stale: false` even while the DB trailed a fresher log
 * sitting under a different project — the exact "stale: false" trap this
 * issue reports.
 */
import { describe, expect, it, vi } from 'vitest';

const OTHER_PROJECT_MTIME = Date.parse('2026-09-06T21:39:00.000Z');

vi.mock('../../src/analytics/log-parser.js', () => ({
  listAllSessions: () => [
    {
      filePath: '/fake/.claude/projects/other-proj/sess-fresh.jsonl',
      projectPath: '/other/project',
      client: 'claude-code',
      mtime: OTHER_PROJECT_MTIME,
    },
  ],
  parseSessionFile: () => null,
}));

import { AnalyticsStore } from '../../src/analytics/analytics-store.js';
import { buildIngestionStatus, syncProjectAnalytics } from '../../src/analytics/sync.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';
import path from 'node:path';

describe('syncProjectAnalytics() — freshness must be machine-wide (TRA-1072)', () => {
  it("reports the other project's newer log as newest_log_mtime, not null", () => {
    const tmpDir = createTmpDir('sync-project-freshness-');
    const store = new AnalyticsStore(path.join(tmpDir, 'analytics.db'));
    try {
      const sync = syncProjectAnalytics(store, '/project/without/its/own/logs');

      expect(sync.newest_log_mtime).toBe(OTHER_PROJECT_MTIME);

      // Feed that into the same pipeline get_session_analytics uses: an old
      // watermark plus this sync result must come out stale, not silently fresh.
      const status = buildIngestionStatus(
        { parsed_at: '2026-09-04T08:02:57.929Z', files_tracked: 3601 },
        sync.newest_log_mtime,
      );
      expect(status.stale).toBe(true);
      expect(status.freshness).toBe('stale');
    } finally {
      store.close();
      removeTmpDir(tmpDir);
    }
  });
});
