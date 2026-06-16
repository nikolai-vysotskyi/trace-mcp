/**
 * Truth table for canSkipFullPostprocess() — the gate that lets a full
 * (non-incremental) indexAll skip edge resolution + LSP + env scan when the
 * persisted graph is provably current. This is the fix for the daemon
 * OOM-restart loop: without it, every daemon start re-resolves every
 * project's full edge graph even when extraction hash-skipped 100% of files.
 *
 * The decision is pure (no fs/git/db), so the truth table is exhaustive and
 * fast. The I/O that feeds it (getStats / readGitHeadSha / getRepoMetadata)
 * is trivial glue covered by the wiring in runPipeline().
 */
import { describe, expect, it } from 'vitest';
import { canSkipFullPostprocess } from '../pipeline.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** An unchanged-since-last-index git project on daemon restart: the skip case. */
function unchanged() {
  return {
    force: false,
    indexed: 0,
    errors: 0,
    totalEdges: 1234,
    currentHead: SHA_A,
    storedHead: SHA_A,
  };
}

describe('canSkipFullPostprocess', () => {
  it('skips when nothing changed since the last index (HEAD + content match)', () => {
    expect(canSkipFullPostprocess(unchanged())).toBe(true);
  });

  it('never skips a forced rebuild (post-update / FK-recovery must re-resolve)', () => {
    expect(canSkipFullPostprocess({ ...unchanged(), force: true })).toBe(false);
  });

  it('does not skip when extraction actually indexed files', () => {
    expect(canSkipFullPostprocess({ ...unchanged(), indexed: 3 })).toBe(false);
  });

  it('does not skip when extraction reported errors', () => {
    expect(canSkipFullPostprocess({ ...unchanged(), errors: 1 })).toBe(false);
  });

  it('does not skip a first/empty index (no edges yet)', () => {
    expect(canSkipFullPostprocess({ ...unchanged(), totalEdges: 0 })).toBe(false);
  });

  it('does not skip when HEAD moved (new commits)', () => {
    expect(canSkipFullPostprocess({ ...unchanged(), currentHead: SHA_B })).toBe(false);
  });

  it('does not skip non-git projects (no current HEAD to prove freshness)', () => {
    expect(canSkipFullPostprocess({ ...unchanged(), currentHead: null })).toBe(false);
  });

  it('does not skip when no HEAD was ever stamped', () => {
    expect(canSkipFullPostprocess({ ...unchanged(), storedHead: null })).toBe(false);
  });
});
