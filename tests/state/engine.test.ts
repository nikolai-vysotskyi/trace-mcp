import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { StateEngine } from '../../src/state/engine.js';
import { applyJsonMergePatch } from '../../src/state/patch.js';
import { formatState, serializeStateToMarkdown } from '../../src/state/serializer.js';
import { AgentExecutionStateSchema } from '../../src/state/types.js';

describe('StateEngine and RFC 7396 Patch', () => {
  it('applies RFC 7396 JSON merge patch correctly', () => {
    const target = { a: 'b', c: { d: 'e', f: 'g' } };
    const patch = { a: 'z', c: { f: null, h: 'new' } };
    const result = applyJsonMergePatch(target, patch) as Record<string, unknown>;

    expect(result.a).toBe('z');
    expect((result.c as Record<string, unknown>).d).toBe('e');
    expect((result.c as Record<string, unknown>).f).toBeUndefined();
    expect((result.c as Record<string, unknown>).h).toBe('new');
  });

  it('initializes in-memory task state with plan and metadata', () => {
    const engine = new StateEngine();
    const state = engine.init('task-123', 'Implement feature X', ['Step 1', 'Step 2']);

    expect(state.task_id).toBe('task-123');
    expect(state.goal).toBe('Implement feature X');
    expect(state.status).toBe('running');
    expect(state.version).toBe(1);
    expect(state.plan.steps).toHaveLength(2);
    expect(state.plan.steps[0].status).toBe('in_progress');
    expect(state.plan.steps[1].status).toBe('pending');
  });

  it('patches and increments version monotonically', () => {
    const engine = new StateEngine();
    engine.init('task-123', 'Implement feature X', ['Step 1']);

    const res = engine.patch('task-123', {
      plan: {
        steps: [{ id: '1', title: 'Step 1', status: 'completed' }],
      },
      facts: {
        architecture_notes: ['Architecture note 1'],
      },
    });

    expect(res.success).toBe(true);
    expect(res.version).toBe(2);
    expect(res.state.plan.steps[0].status).toBe('completed');
    expect(res.state.facts.architecture_notes).toContain('Architecture note 1');
  });

  it('supports checkpoints and rollback', () => {
    const engine = new StateEngine();
    engine.init('task-123', 'Base goal', ['Step 1']);

    engine.patch('task-123', {
      working_context: { modified_files: ['src/a.ts'] },
    });

    const cp = engine.checkpoint('task-123', 'cp-stable');
    expect(cp.label).toBe('cp-stable');

    // Make an erroneous change
    engine.patch('task-123', {
      working_context: { modified_files: ['src/a.ts', 'src/broken.ts'] },
      status: 'failed',
    });
    expect(engine.get('task-123')?.status).toBe('failed');

    // Rollback to checkpoint
    const restored = engine.rollback('task-123', 'cp-stable');
    expect(restored.status).toBe('running');
    expect(restored.working_context.modified_files).toEqual(['src/a.ts']);
  });

  it('records dead ends uniquely', () => {
    const engine = new StateEngine();
    engine.init('task-123', 'Test task');

    engine.addDeadEnd('task-123', 'Tried sync file read');
    engine.addDeadEnd('task-123', 'Tried sync file read'); // duplicate
    engine.addDeadEnd('task-123', 'Tried unbuffered socket');

    const state = engine.get('task-123')!;
    expect(state.blockers_and_dead_ends.dead_ends).toHaveLength(2);
    expect(state.blockers_and_dead_ends.dead_ends).toContain('Tried sync file read');
    expect(state.blockers_and_dead_ends.dead_ends).toContain('Tried unbuffered socket');
  });

  it('serializes state into compact Markdown with all sections', () => {
    const engine = new StateEngine();
    engine.init('task-123', 'Refactor parser', ['Step 1: Parse', 'Step 2: Emit']);
    engine.patch('task-123', {
      facts: {
        key_symbols: ['parseAST', 'emitCode'],
        architecture_notes: ['Parser must be async'],
      },
      working_context: {
        modified_files: ['src/parser.ts'],
        test_targets: ['tests/parser.test.ts'],
        diff_summary: '+12 -4 lines',
      },
      blockers_and_dead_ends: {
        last_error: 'SyntaxError: unexpected token',
        dead_ends: ['Regex parsing approach failed'],
      },
      next_action: 'Switch to AST token stream scanner',
    });

    const md = serializeStateToMarkdown(engine.get('task-123')!);
    expect(md).toContain('## Task State: Refactor parser');
    expect(md).toContain('### Plan:');
    expect(md).toContain('### Facts:');
    expect(md).toContain('### Context:');
    expect(md).toContain('### Dead Ends & Blockers:');
    expect(md).toContain('[x-discarded] Regex parsing approach failed');
    expect(md).toContain('### Next Action:');
  });

  it('persists and retrieves states with SQLite backend', () => {
    const db = new Database(':memory:');
    const engine = new StateEngine({ db });

    engine.init('task-sqlite', 'SQLite Task', ['Step 1']);
    engine.patch('task-sqlite', {
      working_context: { modified_files: ['src/sqlite.ts'] },
    });

    const state = engine.get('task-sqlite');
    expect(state).not.toBeNull();
    expect(state?.task_id).toBe('task-sqlite');
    expect(state?.version).toBe(2);
    expect(state?.working_context.modified_files).toContain('src/sqlite.ts');

    const formattedCompact = engine.getFormatted('task-sqlite', 'compact');
    expect(formattedCompact).toContain('Task State: SQLite Task');

    const formattedJson = engine.getFormatted('task-sqlite', 'json');
    expect(JSON.parse(formattedJson!)).toHaveProperty('task_id', 'task-sqlite');

    db.close();
  });
});
