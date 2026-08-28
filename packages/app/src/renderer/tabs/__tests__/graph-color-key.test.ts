/* Colour key + label truncation for the Graph Explorer (TRA-296).
 *
 * Two things this locks down:
 *  1. node colour is a CAPPED categorical encoding — at most
 *     CATEGORICAL_SLOTS named categories, everything else folded into one
 *     "Other" entry, ranked by node count and stable across renders. Before
 *     this the graph painted 18 language brand colours / a hashed 10-entry
 *     framework palette with no cap and no legend.
 *  2. overlay labels are length-capped, so the collision pass can reserve a
 *     box the label actually fits inside.
 */
import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL_SLOTS,
  buildColorKey,
  categoryOf,
  labelBox,
  labelWidth,
  labelsCollide,
  truncateLabel,
} from '../GraphExplorerGPU';

type Node = Parameters<typeof categoryOf>[0];

const node = (over: Partial<Node> & { id: string }): Node =>
  ({ community: 0, importance: 0, ...over }) as Node;

const COMM = new Map<number, string>([
  [1, 'app/models'],
  [2, 'app/http'],
  [3, 'tests'],
  [4, 'config'],
  [5, 'database'],
  [6, 'routes'],
]);

describe('categoryOf', () => {
  it('keys a node by community label, language or framework role', () => {
    const n = node({ id: 'a', community: 1, language: 'php', framework_role: 'controller' });
    expect(categoryOf(n, 'community', COMM)).toEqual({ key: 'c:1', label: 'app/models' });
    expect(categoryOf(n, 'language', COMM)).toEqual({ key: 'l:php', label: 'php' });
    expect(categoryOf(n, 'framework_role', COMM)).toEqual({
      key: 'f:controller',
      label: 'controller',
    });
  });

  it('falls back to Other when the category is missing or blank', () => {
    expect(categoryOf(node({ id: 'a', language: '  ' }), 'language', COMM).label).toBe('Other');
    expect(categoryOf(node({ id: 'a' }), 'framework_role', COMM).label).toBe('Other');
    // Community 99 has no label from the server.
    expect(categoryOf(node({ id: 'a', community: 99 }), 'community', COMM).label).toBe('Other');
  });
});

describe('buildColorKey', () => {
  /** n nodes in one community. */
  const group = (community: number, n: number): Node[] =>
    Array.from({ length: n }, (_, i) => node({ id: `${community}-${i}`, community }));

  it('gives the top categories a slot and folds the rest into one Other', () => {
    const nodes = [
      ...group(1, 10),
      ...group(2, 8),
      ...group(3, 6),
      ...group(4, 4),
      ...group(5, 2),
      ...group(6, 1),
    ];
    const key = buildColorKey(nodes, 'community', COMM);

    const named = key.filter((e) => e.slot >= 0);
    expect(named).toHaveLength(CATEGORICAL_SLOTS);
    expect(named.map((e) => e.label)).toEqual(['app/models', 'app/http', 'tests', 'config']);
    // Fixed order, never cycled: slot n is always the n-th ranked category.
    expect(named.map((e) => e.slot)).toEqual([0, 1, 2, 3]);

    const other = key.filter((e) => e.slot === -1);
    expect(other).toHaveLength(1);
    expect(other[0].label).toBe('Other');
    expect(other[0].count).toBe(3); // 2 + 1, the two ranked out of the palette
  });

  it('sweeps unlabelled nodes into the same Other bucket', () => {
    const nodes = [...group(1, 3), ...group(99, 5)];
    const key = buildColorKey(nodes, 'community', COMM);
    expect(key.map((e) => e.label)).toEqual(['app/models', 'Other']);
    expect(key[1].count).toBe(5);
  });

  it('omits Other entirely when everything fits in the palette', () => {
    const key = buildColorKey([...group(1, 3), ...group(2, 1)], 'community', COMM);
    expect(key).toHaveLength(2);
    expect(key.every((e) => e.slot >= 0)).toBe(true);
  });

  it('breaks count ties on label so the assignment is stable', () => {
    const forward = buildColorKey([...group(2, 5), ...group(1, 5)], 'community', COMM);
    const reversed = buildColorKey([...group(1, 5), ...group(2, 5)], 'community', COMM);
    expect(forward.map((e) => e.key)).toEqual(reversed.map((e) => e.key));
    expect(forward[0].label).toBe('app/http'); // sorts before app/models
  });

  it('returns nothing for an empty graph', () => {
    expect(buildColorKey([], 'community', COMM)).toEqual([]);
  });
});

describe('truncateLabel', () => {
  it('leaves short labels alone', () => {
    expect(truncateLabel('User.php')).toBe('User.php');
  });

  it('middle-truncates so the extension survives', () => {
    const long = '0001_01_01_000001_create_cache_table.php';
    const out = truncateLabel(long);
    expect(out.length).toBeLessThanOrEqual(26);
    expect(out).toContain('…');
    expect(out.startsWith('0001_01_01_00')).toBe(true);
    expect(out.endsWith('.php')).toBe(true);
  });

  it('honours an explicit cap', () => {
    expect(truncateLabel('abcdefghij', 5)).toHaveLength(5);
  });
});

describe('label collision boxes', () => {
  /* The exact pairs that overprinted each other in the TRA-296 screenshot. The
     old pass reserved a fixed ±70px per label, so anything wider than 140px
     silently overlapped its neighbour. */
  const OLD_FIXED_HALF_WIDTH = 70;

  it('reserves a box as wide as the text, not a fixed 140px', () => {
    const long = truncateLabel('0001_01_01_000001_create_cache_table.php');
    expect(labelWidth(long)).toBeGreaterThan(OLD_FIXED_HALF_WIDTH * 2 * 0.5);
    // A short label must NOT over-reserve — that would starve the canvas.
    expect(labelWidth('User.php')).toBeLessThan(labelWidth(long));
  });

  it('rejects the overlap the old fixed-width rule let through', () => {
    // `AccountOAuthController.php` (26 chars, ~145px) 100px from
    // `AccountFlowTest.php` (19 chars, ~109px) on the same row: the two boxes
    // overlap by ~27px, but each old ±70px reservation cleared 100px apart.
    const a = labelBox(400, 300, 'AccountOAuthController.php');
    const b = labelBox(500, 300, 'AccountFlowTest.php');
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(OLD_FIXED_HALF_WIDTH); // old rule: no collision
    expect(labelsCollide(a, b)).toBe(true); // new rule: collision
  });

  it('lets genuinely clear labels through', () => {
    expect(labelsCollide(labelBox(100, 300, 'User.php'), labelBox(400, 300, 'Invoice.php'))).toBe(
      false,
    );
  });

  it('separates rows on the vertical clearance alone', () => {
    const a = labelBox(400, 300, 'AccountOAuthController.php');
    expect(labelsCollide(a, labelBox(400, 310, 'AccountController.php'))).toBe(true);
    expect(labelsCollide(a, labelBox(400, 320, 'AccountController.php'))).toBe(false);
  });
});
