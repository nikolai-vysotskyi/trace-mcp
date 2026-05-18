/**
 * End-to-end coverage for the P2.3 incremental cursor on the provider
 * (Hermes/Codex) mining path.
 *
 * Drives `mineProviderSessions` against a fake SessionProvider so we can
 * control the message stream precisely and assert that re-mining only
 * processes the delta. Cursor primitive is (timestamp, message_id) — see
 * `DecisionStore.getProviderSessionCursor` for the contract.
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { mineProviderSessions } from '../../src/memory/conversation-miner-providers.js';
import {
  __resetSessionProviderRegistryForTests,
  getSessionProviderRegistry,
} from '../../src/session/providers/registry.js';
import type {
  DiscoverOpts,
  RawMessage,
  SessionHandle,
  SessionProvider,
} from '../../src/session/providers/types.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

/**
 * Fake Hermes-like provider whose discover/streamMessages are driven by a
 * mutable in-memory script. Each test reassigns `currentScript` between
 * mining passes to simulate appends / rotations / no-ops.
 */
type ScriptedMessage = {
  ts: number;
  role: RawMessage['role'];
  text: string;
};

interface ScriptedSession {
  sessionId: string;
  sizeBytes?: number;
  lastModifiedMs: number;
  messages: ScriptedMessage[];
}

let currentScript: ScriptedSession[] = [];

class FakeProvider implements SessionProvider {
  readonly id = 'hermes';
  readonly displayName = 'Fake Hermes';

  async discover(_opts: DiscoverOpts): Promise<SessionHandle[]> {
    return currentScript.map((s) => ({
      providerId: this.id,
      sessionId: s.sessionId,
      sourcePath: `sqlite:///tmp/fake-state.db?row=${s.sessionId}`,
      projectPath: undefined,
      lastModifiedMs: s.lastModifiedMs,
      sizeBytes: s.sizeBytes,
    }));
  }

  async parse(): Promise<null> {
    return null;
  }

  async *streamMessages(handle: SessionHandle): AsyncIterable<RawMessage> {
    const session = currentScript.find((s) => s.sessionId === handle.sessionId);
    if (!session) return;
    for (const m of session.messages) {
      yield {
        role: m.role,
        text: m.text,
        timestampMs: m.ts,
      };
    }
  }
}

/** Build a message stream that contains enough decision-shaped content to
 *  yield at least one extracted decision. Each pass uses a unique prefix
 *  so the dedup key (normalized title) differs between passes. */
function decisionMessages(prefix: string, baseTs: number): ScriptedMessage[] {
  return [
    { ts: baseTs, role: 'user', text: `${prefix} — what cache for hot reads?` },
    {
      ts: baseTs + 1000,
      role: 'assistant',
      text: `${prefix} — we decided to use Redis for session caching because it handles high throughput consistently across nodes.`,
    },
  ];
}

describe('mineProviderSessions — incremental cursor', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = createTmpDir('provider-incr-');
    projectRoot = tmpDir;
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    __resetSessionProviderRegistryForTests();
    getSessionProviderRegistry().register(new FakeProvider());
    currentScript = [];
  });

  afterEach(() => {
    store.close();
    if (tmpDir) removeTmpDir(tmpDir);
    __resetSessionProviderRegistryForTests();
    currentScript = [];
  });

  function mine(extra: { force?: boolean; incrementalCursor?: boolean } = {}) {
    const counters = { scanned: 0, skipped: 0, mined: 0, extracted: 0, errors: 0 };
    return mineProviderSessions(
      store,
      {
        projectRoot,
        rejectThreshold: 0,
        reviewThreshold: 0.95,
        ...extra,
      },
      counters,
    ).then(() => counters);
  }

  it('first pass on a fresh session reads everything and persists the cursor', async () => {
    currentScript = [
      {
        sessionId: 's1',
        sizeBytes: 100,
        lastModifiedMs: 1_700_000_000_000,
        messages: decisionMessages('p1', 1_700_000_000_000),
      },
    ];

    const c = await mine();
    expect(c.scanned).toBe(1);
    expect(c.mined).toBe(1);
    expect(c.extracted).toBeGreaterThan(0);

    // Cursor row exists and points at the last consumed message's timestamp.
    const cursor = store.getProviderSessionCursor('hermes:s1', 100, 1_700_000_000_000);
    // Same size + mtime → skip (null).
    expect(cursor).toBeNull();
  });

  it('second pass with no new messages skips without iterating', async () => {
    currentScript = [
      {
        sessionId: 's2',
        sizeBytes: 200,
        lastModifiedMs: 1_700_000_100_000,
        messages: decisionMessages('p2', 1_700_000_100_000),
      },
    ];
    const first = await mine();
    expect(first.mined).toBe(1);

    // Same handle attrs → cursor returns null → session is skipped.
    const second = await mine();
    expect(second.mined).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.extracted).toBe(0);
  });

  it('appended messages are processed on the second pass', async () => {
    const base = 1_700_000_200_000;
    currentScript = [
      {
        sessionId: 's3',
        sizeBytes: 300,
        lastModifiedMs: base,
        messages: decisionMessages('p3a', base),
      },
    ];
    const first = await mine();
    expect(first.mined).toBe(1);
    const firstExtracted = first.extracted;
    expect(firstExtracted).toBeGreaterThan(0);

    // Append fresh decision content with later timestamps and bump size+mtime
    // so the cursor enters the 'incremental' branch.
    const appended = decisionMessages('p3b', base + 10_000);
    currentScript[0] = {
      ...currentScript[0],
      sizeBytes: 600,
      lastModifiedMs: base + 20_000,
      messages: [...currentScript[0].messages, ...appended],
    };
    const second = await mine();
    expect(second.mined).toBe(1);
    expect(second.extracted).toBeGreaterThan(0);
  });

  it('rotated session (size shrank) triggers a full re-mine', async () => {
    const base = 1_700_000_300_000;
    currentScript = [
      {
        sessionId: 's4',
        sizeBytes: 500,
        lastModifiedMs: base,
        messages: decisionMessages('long-content', base),
      },
    ];
    const first = await mine();
    expect(first.extracted).toBeGreaterThan(0);

    // Rotated: smaller size + fresh content. Cursor should restart from 0.
    currentScript[0] = {
      sessionId: 's4',
      sizeBytes: 50,
      lastModifiedMs: base + 5_000,
      messages: decisionMessages('rotated-content', base + 100_000),
    };
    const second = await mine();
    expect(second.mined).toBe(1);
    expect(second.extracted).toBeGreaterThan(0);
  });

  it('incrementalCursor=false falls back to legacy binary semantics', async () => {
    const base = 1_700_000_400_000;
    currentScript = [
      {
        sessionId: 's5',
        sizeBytes: 100,
        lastModifiedMs: base,
        messages: decisionMessages('legacy', base),
      },
    ];
    const first = await mine({ incrementalCursor: false });
    expect(first.mined).toBe(1);

    // Append — but legacy mode IGNORES it (binary mined/unmined gate).
    currentScript[0] = {
      ...currentScript[0],
      sizeBytes: 200,
      lastModifiedMs: base + 1_000,
      messages: [...currentScript[0].messages, ...decisionMessages('legacy-2', base + 5_000)],
    };
    const second = await mine({ incrementalCursor: false });
    expect(second.mined).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.extracted).toBe(0);
  });

  it('force=true ignores cursor and re-reads everything', async () => {
    const base = 1_700_000_500_000;
    currentScript = [
      {
        sessionId: 's6',
        sizeBytes: 150,
        lastModifiedMs: base,
        messages: decisionMessages('forced', base),
      },
    ];
    const first = await mine();
    expect(first.extracted).toBeGreaterThan(0);

    // Same handle attrs — without force this is a skip. With force it re-mines.
    const second = await mine({ force: true });
    expect(second.mined).toBe(1);
    // Force re-reads all messages, but dedup-by-normalized-title in
    // extractDecisions filters identical titles within a single pass — across
    // passes the deduper does not span sessions, so we expect a fresh > 0
    // extraction count here.
    expect(second.extracted).toBeGreaterThan(0);
  });

  it('empty session stream still advances the cursor on incremental path', async () => {
    currentScript = [
      {
        sessionId: 's7',
        sizeBytes: 50,
        lastModifiedMs: 1_700_000_600_000,
        messages: [],
      },
    ];
    const first = await mine();
    // Empty stream → counted as skipped but the cursor row gets created so a
    // subsequent unchanged pass short-circuits.
    expect(first.skipped).toBe(1);
    expect(first.extracted).toBe(0);

    const second = await mine();
    expect(second.skipped).toBe(1);
    // Same size + mtime ⇒ getProviderSessionCursor returns null ⇒ skipped
    // before we even open the message stream. The mined count stays 0.
    expect(second.mined).toBe(0);
  });

  it('legacy fallback path persists a markSessionMined row', async () => {
    const base = 1_700_000_700_000;
    currentScript = [
      {
        sessionId: 's8',
        sizeBytes: 100,
        lastModifiedMs: base,
        messages: decisionMessages('legacy-mark', base),
      },
    ];
    await mine({ incrementalCursor: false });
    // The legacy code path writes to the file-based mined_sessions table via
    // markSessionMined, keyed by the provider:sessionId pseudo-path.
    expect(store.isSessionMined('hermes:s8')).toBe(true);
  });

  it('no-projectRoot is a no-op (provider mining requires explicit scope)', async () => {
    currentScript = [
      {
        sessionId: 's9',
        sizeBytes: 100,
        lastModifiedMs: 1_700_000_800_000,
        messages: decisionMessages('no-scope', 1_700_000_800_000),
      },
    ];
    const counters = { scanned: 0, skipped: 0, mined: 0, extracted: 0, errors: 0 };
    await mineProviderSessions(store, { rejectThreshold: 0 }, counters);
    expect(counters.scanned).toBe(0);
    expect(counters.mined).toBe(0);
    expect(counters.extracted).toBe(0);
  });

  it('after incremental pass, only the new messages are streamed (assertion via cursor advance)', async () => {
    const base = 1_700_001_000_000;
    currentScript = [
      {
        sessionId: 's10',
        sizeBytes: 100,
        lastModifiedMs: base,
        messages: decisionMessages('first', base),
      },
    ];
    await mine();
    // The first pass should record the highest timestamp seen (base + 1000).
    // We probe via a cursor lookup with a different size/mtime so we don't
    // hit the unchanged-skip branch.
    const after = store.getProviderSessionCursor('hermes:s10', 200, base + 1_000);
    expect(after).not.toBeNull();
    expect(after?.lastTimestampMs).toBeGreaterThanOrEqual(base + 1_000);
  });
});
