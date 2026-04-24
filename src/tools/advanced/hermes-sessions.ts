/**
 * `discover_hermes_sessions` — list Hermes Agent sessions visible on this
 * machine. Hermes conversations are global (no per-project binding), so the
 * result set is NOT filtered by the current project.
 */
import { ok, err, type Result } from 'neverthrow';

import { HermesSessionProvider } from '../../session/providers/hermes.js';
import { getSessionProviderRegistry } from '../../session/providers/registry.js';
import { dbError, type TraceMcpError } from '../../errors.js';

export interface DiscoveredHermesSession {
  sessionId: string;
  sourcePath: string;
  profile: string | null;
  lastActivity: string | null;
  sizeBytes: number | null;
}

export interface DiscoverHermesSessionsResult {
  enabled: boolean;
  sessions: DiscoveredHermesSession[];
  total: number;
  home?: string;
  message?: string;
}

export interface DiscoverHermesSessionsOpts {
  homeOverride?: string;
  profile?: string;
  limit?: number;
}

export async function discoverHermesSessions(
  opts: DiscoverHermesSessionsOpts,
): Promise<Result<DiscoverHermesSessionsResult, TraceMcpError>> {
  const registry = getSessionProviderRegistry();
  let provider = registry.get('hermes');

  // Ad-hoc registration for callers that bypass the server boot path
  // (CLI, tests). Safe because `register` is idempotent via ctor check.
  if (!provider) {
    provider = new HermesSessionProvider();
    try {
      registry.register(provider);
    } catch {
      // Race with another caller — re-read.
      provider = registry.get('hermes') ?? provider;
    }
  }

  try {
    const handles = await provider.discover({
      configOverrides: {
        homeOverride: opts.homeOverride,
        profile: opts.profile,
      },
    });

    const limit = opts.limit ?? 100;
    const sorted = [...handles].sort((a, b) => b.lastModifiedMs - a.lastModifiedMs).slice(0, limit);

    const sessions: DiscoveredHermesSession[] = sorted.map((h) => ({
      sessionId: h.sessionId,
      sourcePath: h.sourcePath,
      profile: extractProfileFromSessionId(h.sessionId),
      lastActivity: h.lastModifiedMs ? new Date(h.lastModifiedMs).toISOString() : null,
      sizeBytes: h.sizeBytes ?? null,
    }));

    return ok({
      enabled: true,
      sessions,
      total: handles.length,
    });
  } catch (e) {
    return err(dbError(`Hermes discovery failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

function extractProfileFromSessionId(id: string): string | null {
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(0, colon) : null;
}
