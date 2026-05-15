/**
 * Behavioural coverage for `DecisionStore.getTimeline()` (the
 * `get_decision_timeline` MCP tool surface).
 *
 * Asserts:
 *   - Returns an array of `{ id, title, type, valid_from, valid_until,
 *     is_active }` entries.
 *   - Default ordering is `valid_from ASC` (chronological, oldest first).
 *   - `symbol_id` filter narrows to decisions linked to that symbol.
 *   - `file_path` filter narrows to decisions linked to that file.
 *   - `limit` caps the number of entries returned.
 *   - Empty timeline returns an empty array (count semantics → length 0).
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/decision-timeline-fixture';

describe('get_decision_timeline — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('decision-timeline-behav-');
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('returns entries in chronological (valid_from ASC) order', () => {
    store.addDecision({
      title: 'Second decision',
      content: '...',
      type: 'tech_choice',
      project_root: PROJECT,
      valid_from: '2024-02-01T00:00:00.000Z',
    });
    store.addDecision({
      title: 'First decision',
      content: '...',
      type: 'tech_choice',
      project_root: PROJECT,
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    store.addDecision({
      title: 'Third decision',
      content: '...',
      type: 'tech_choice',
      project_root: PROJECT,
      valid_from: '2024-03-01T00:00:00.000Z',
    });

    const timeline = store.getTimeline({ project_root: PROJECT });
    expect(timeline).toHaveLength(3);
    expect(timeline.map((e) => e.title)).toEqual([
      'First decision',
      'Second decision',
      'Third decision',
    ]);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i - 1].valid_from <= timeline[i].valid_from).toBe(true);
    }
  });

  it('symbol_id filter narrows to decisions linked to that symbol', () => {
    store.addDecision({
      title: 'About AuthProvider',
      content: '...',
      type: 'architecture_decision',
      project_root: PROJECT,
      symbol_id: 'src/auth.ts::AuthProvider#class',
    });
    store.addDecision({
      title: 'About UserModel',
      content: '...',
      type: 'architecture_decision',
      project_root: PROJECT,
      symbol_id: 'src/user.ts::UserModel#class',
    });

    const timeline = store.getTimeline({
      project_root: PROJECT,
      symbol_id: 'src/auth.ts::AuthProvider#class',
    });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].title).toBe('About AuthProvider');
  });

  it('file_path filter narrows to decisions linked to that file', () => {
    store.addDecision({
      title: 'In auth file',
      content: '...',
      type: 'preference',
      project_root: PROJECT,
      file_path: 'src/auth.ts',
    });
    store.addDecision({
      title: 'In billing file',
      content: '...',
      type: 'preference',
      project_root: PROJECT,
      file_path: 'src/billing.ts',
    });

    const timeline = store.getTimeline({
      project_root: PROJECT,
      file_path: 'src/auth.ts',
    });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].title).toBe('In auth file');
  });

  it('limit caps the number of timeline entries', () => {
    for (let i = 1; i <= 5; i++) {
      store.addDecision({
        title: `Decision ${i}`,
        content: '...',
        type: 'tech_choice',
        project_root: PROJECT,
        valid_from: `2024-0${i}-01T00:00:00.000Z`,
      });
    }
    const limited = store.getTimeline({ project_root: PROJECT, limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('entries expose { id, title, type, valid_from, valid_until, is_active } shape', () => {
    const added = store.addDecision({
      title: 'Shape check',
      content: '.',
      type: 'discovery',
      project_root: PROJECT,
      valid_from: '2024-01-01T00:00:00.000Z',
    });

    const [entry] = store.getTimeline({ project_root: PROJECT });
    expect(entry.id).toBe(added.id);
    expect(entry.title).toBe('Shape check');
    expect(entry.type).toBe('discovery');
    expect(entry.valid_from).toBe('2024-01-01T00:00:00.000Z');
    expect(entry.valid_until).toBeNull();
    expect(entry.is_active).toBe(1);
  });

  it('invalidated decisions still appear, but with is_active=0 and a valid_until', () => {
    const added = store.addDecision({
      title: 'Will be invalidated',
      content: '.',
      type: 'tradeoff',
      project_root: PROJECT,
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    expect(store.invalidateDecision(added.id, '2024-06-01T00:00:00.000Z')).toBe(true);

    const [entry] = store.getTimeline({ project_root: PROJECT });
    expect(entry.id).toBe(added.id);
    expect(entry.valid_until).toBe('2024-06-01T00:00:00.000Z');
    expect(entry.is_active).toBe(0);
  });

  it('empty store returns an empty timeline array', () => {
    expect(store.getTimeline({ project_root: PROJECT })).toEqual([]);
    expect(store.getTimeline({})).toEqual([]);
  });
});
