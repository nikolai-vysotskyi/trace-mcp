/**
 * Guards the daemon auto-spawn timeout default. StdioSession.bootstrap() blocks
 * on tryAutoSpawnDaemon() before the MCP transport starts, so this value caps
 * how long the client waits for the daemon before falling back to local mode.
 *
 * The invariant that actually matters: it must stay under MCP clients' ~30s
 * connection timeout, otherwise a slow-but-healthy daemon would make the whole
 * MCP connection time out instead of just falling back to local. The default
 * was raised from 5s -> 20s to stop premature local fallback (#209); this test
 * pins both that it was raised and that it stays under the client ceiling.
 */
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../config.js';

/** MCP clients (e.g. Claude Code) abort an MCP server connection after ~30s. */
const MCP_CLIENT_CONNECT_TIMEOUT_S = 30;

describe('daemon_spawn_timeout_seconds default', () => {
  const cfg = TraceMcpConfigSchema.parse({});

  it('is patient enough to outlast a heavy daemon warm-up (raised from 5s)', () => {
    expect(cfg.daemon_spawn_timeout_seconds).toBeGreaterThan(5);
  });

  it('stays under the MCP client connection timeout so bootstrap never blocks past it', () => {
    expect(cfg.daemon_spawn_timeout_seconds).toBeLessThan(MCP_CLIENT_CONNECT_TIMEOUT_S);
  });
});
