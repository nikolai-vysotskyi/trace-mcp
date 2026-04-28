import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type * as parcelWatcher from '@parcel/watcher';
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';

type ParcelWatcherModule = typeof parcelWatcher;

/** Debounce window in ms — coalesces rapid saves from editors. */
const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Retry delays (ms) for loading @parcel/watcher on macOS. The prebuilt
 * ad-hoc-signed `.node` bundle can race with amfid/syspolicyd on first load
 * (symptom: "library load disallowed by system policy"). The retry window
 * covers the observed race; subsequent loads succeed because the signature
 * has since been validated by the OS.
 */
const MAC_LOAD_RETRY_DELAYS_MS = [300, 900, 2000];

let cachedWatcher: ParcelWatcherModule | null = null;

function isMacSystemPolicyError(e: unknown): boolean {
  if (process.platform !== 'darwin') return false;
  const err = e as NodeJS.ErrnoException & { message?: string };
  if (err?.code !== 'ERR_DLOPEN_FAILED') return false;
  return (
    typeof err.message === 'string' &&
    err.message.includes('library load disallowed by system policy')
  );
}

function extractDlopenPath(e: unknown): string | null {
  const msg = (e as { message?: string })?.message;
  if (typeof msg !== 'string') return null;
  const match = msg.match(/dlopen\(([^,)]+)/);
  return match ? match[1] : null;
}

/** Ask macOS to verify the signature — forces amfid to complete first-load assessment. */
function primeAmfid(file: string): void {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', file], { stdio: 'ignore', timeout: 5000 });
  } catch {
    /* best effort — even a rejection means amfid has now assessed the file */
  }
}

async function loadParcelWatcher(): Promise<ParcelWatcherModule> {
  if (cachedWatcher) return cachedWatcher;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAC_LOAD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      cachedWatcher = (await import('@parcel/watcher')) as ParcelWatcherModule;
      return cachedWatcher;
    } catch (e) {
      lastErr = e;
      if (!isMacSystemPolicyError(e)) throw e;
      const file = extractDlopenPath(e);
      logger.warn({ file, attempt }, 'macOS rejected native watcher load — retrying');
      if (file) primeAmfid(file);
      if (attempt < MAC_LOAD_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, MAC_LOAD_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr;
}

export class FileWatcher {
  private subscription: parcelWatcher.AsyncSubscription | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPaths: Set<string> = new Set();

  constructor(
    private readonly _setTimeout: typeof setTimeout = setTimeout,
    private readonly _clearTimeout: typeof clearTimeout = clearTimeout,
  ) {}

  async start(
    rootPath: string,
    config: TraceMcpConfig,
    onChanges: (paths: string[]) => Promise<void>,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    onDeletes?: (paths: string[]) => Promise<void>,
  ): Promise<void> {
    const watcher = await loadParcelWatcher();
    const traceignore = new TraceignoreMatcher(rootPath, config.ignore ?? {});
    const ignoreDirs = [...traceignore.getSkipDirs()].map((d) => path.join(rootPath, d));

    this.subscription = await watcher.subscribe(
      rootPath,
      async (err, events) => {
        if (err) {
          logger.error({ error: err }, 'Watcher error');
          return;
        }

        const notIgnored = (p: string) => {
          if (ignoreDirs.some((d) => p.startsWith(d))) return false;
          const rel = path.relative(rootPath, p);
          return !traceignore.isIgnored(rel);
        };

        const changed = events
          .filter((e) => e.type === 'create' || e.type === 'update')
          .map((e) => e.path)
          .filter(notIgnored);

        const deleted = events
          .filter((e) => e.type === 'delete')
          .map((e) => e.path)
          .filter(notIgnored);

        if (deleted.length > 0 && onDeletes) {
          logger.debug({ count: deleted.length }, 'File deletions detected');
          await onDeletes(deleted);
        }

        if (changed.length === 0) return;

        // Accumulate paths and debounce — multiple rapid saves collapse into one call
        for (const p of changed) this.pendingPaths.add(p);

        if (this.debounceTimer) this._clearTimeout(this.debounceTimer);
        this.debounceTimer = this._setTimeout(async () => {
          const paths = Array.from(this.pendingPaths);
          this.pendingPaths.clear();
          this.debounceTimer = null;
          logger.debug({ count: paths.length }, 'File changes detected');
          try {
            await onChanges(paths);
          } catch (e) {
            logger.error({ error: e }, 'File change handler failed');
          }
        }, debounceMs);
      },
      {
        ignore: ignoreDirs,
      },
    );

    logger.info({ rootPath }, 'File watcher started');
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      this._clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.pendingPaths.clear();
    }
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
      logger.info('File watcher stopped');
    }
  }
}

/** @internal — exported for tests to reset module-scoped cache between cases. */
export function __resetWatcherCache(): void {
  cachedWatcher = null;
}
