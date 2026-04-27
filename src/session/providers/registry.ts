import type { TraceMcpConfig } from '../../config.js';
import type { SessionProvider } from './types.js';

/**
 * Registry for SessionProvider instances.
 *
 * The two legacy providers (`claude-code`, `claw-code`) are still inlined
 * in `listAllSessions` / `mineSessions` and not yet wrapped behind this
 * interface. New providers (starting with Hermes) register here and are
 * consumed AFTER the legacy branches — see mineSessions wiring.
 *
 * Eventually the legacy branches should collapse into a single loop that
 * iterates the registry; when they do, this comment and the additive hook
 * in `conversation-miner-providers.ts` go away.
 */
export class SessionProviderRegistry {
  private providers = new Map<string, SessionProvider>();

  register(p: SessionProvider): void {
    if (this.providers.has(p.id)) {
      throw new Error(`SessionProvider already registered: ${p.id}`);
    }
    this.providers.set(p.id, p);
  }

  get(id: string): SessionProvider | undefined {
    return this.providers.get(id);
  }

  all(): SessionProvider[] {
    return [...this.providers.values()];
  }

  /** Providers that are enabled according to the current config.
   *
   * Each provider decides its own enablement policy via `isEnabled(config)`
   * below. Providers without a dedicated config flag default to enabled.
   * This keeps the legacy zero-config experience unchanged. */
  enabledFor(config: TraceMcpConfig): SessionProvider[] {
    return this.all().filter((p) => isProviderEnabled(p.id, config));
  }
}

/** Per-provider enablement resolution.
 *
 * Additive policy: a provider is enabled unless its config section sets
 * `enabled: false` or (for providers with an `'auto'` option) `'auto'`
 * resolves to false at discovery time. Discovery-time checks happen inside
 * the provider's own `discover()` — this function only gates static config. */
function isProviderEnabled(id: string, config: TraceMcpConfig): boolean {
  switch (id) {
    case 'hermes': {
      const h = (config as unknown as { hermes?: { enabled?: 'auto' | boolean } }).hermes;
      // 'auto' / undefined → enabled; provider checks for state.db at discover-time.
      return h?.enabled !== false;
    }
    default:
      return true;
  }
}

// Module-level singleton — shared by indexer / miner / discover tools so
// providers registered at boot are visible everywhere.
let singleton: SessionProviderRegistry | null = null;

export function getSessionProviderRegistry(): SessionProviderRegistry {
  if (!singleton) singleton = new SessionProviderRegistry();
  return singleton;
}

/** Test-only: reset the singleton between tests. */
export function __resetSessionProviderRegistryForTests(): void {
  singleton = null;
}
