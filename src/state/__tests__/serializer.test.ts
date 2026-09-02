import { describe, expect, it } from 'vitest';
import { AgentExecutionStateSchema } from '../schema.js';
import { estimateTokenCount, serializeStateToMarkdown } from '../serializer.js';

describe('Markdown State Serializer', () => {
  it('serializes complete state into compact markdown format', () => {
    const state = AgentExecutionStateSchema.parse({
      task_id: 'TRA-596',
      goal: 'State Engine integration',
      status: 'in_progress',
      plan: {
        active_step_id: 'step_2',
        steps: [
          { id: 'step_1', title: 'Implement SQLite schema', status: 'completed' },
          { id: 'step_2', title: 'Implement MCP tools', status: 'in_progress' },
          { id: 'step_3', title: 'Add Resource subscription', status: 'pending' },
        ],
      },
      facts: {
        architecture_notes: ['Store in ~/.trace-mcp/state.db'],
        key_symbols: ['StateEngine', 'registerStateTools'],
      },
      working_context: {
        modified_files: ['src/state/state-engine.ts', 'src/tools/register/state.ts'],
        diff_summary: '+200 lines',
        test_targets: ['pnpm test src/state'],
      },
      blockers_and_dead_ends: {
        last_error: null,
        dead_ends: [{ approach: 'In-memory only', reason: 'Lost on process restart' }],
      },
      next_action: 'Write trace_state_patch tool',
    });

    const md = serializeStateToMarkdown(state, 2);
    expect(md).toContain('# State: TRA-596 (v2 • in_progress)');
    expect(md).toContain('**Goal:** State Engine integration');
    expect(md).toContain('**Next Action:** Write trace_state_patch tool');
    expect(md).toContain('## Plan (1/3)');
    expect(md).toContain('- [x] Implement SQLite schema');
    expect(md).toContain('- [>] Implement MCP tools *(active)*');
    expect(md).toContain('- [ ] Add Resource subscription');
    expect(md).toContain('`src/state/state-engine.ts`');
    expect(md).toContain('## Dead Ends & Blockers');
    expect(md).toContain('**Avoid approach:** "In-memory only"');

    // Verify token efficiency: standard task state should be ~150-250 tokens
    const tokens = estimateTokenCount(md);
    expect(tokens).toBeLessThan(300);
    expect(tokens).toBeGreaterThan(50);
  });

  it('omits empty sections when no data is present', () => {
    const state = AgentExecutionStateSchema.parse({
      task_id: 'MINIMAL-1',
      goal: 'Just a simple task',
    });

    const md = serializeStateToMarkdown(state, 1);
    expect(md).toContain('# State: MINIMAL-1 (v1 • in_progress)');
    expect(md).toContain('**Goal:** Just a simple task');
    expect(md).not.toContain('## Plan');
    expect(md).not.toContain('## Facts');
    expect(md).not.toContain('## Working Context');
    expect(md).not.toContain('## Dead Ends & Blockers');

    const tokens = estimateTokenCount(md);
    expect(tokens).toBeLessThan(40);
  });
});
