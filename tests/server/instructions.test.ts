import { describe, it, expect } from 'vitest';
import { buildInstructions } from '../../src/server/instructions.js';

describe('buildInstructions — verbosity', () => {
  it('returns empty string when verbosity=none and agentBehavior=off (default)', () => {
    expect(buildInstructions('typescript', 'none')).toBe('');
  });

  it('returns concise one-liner for verbosity=minimal', () => {
    const out = buildInstructions('typescript', 'minimal');
    expect(out).toContain('trace-mcp: framework-aware code intelligence');
    expect(out).toContain('Detected: typescript');
    expect(out).not.toContain('Agent Behavior');
  });

  it('returns the full tool-routing block for verbosity=full', () => {
    const out = buildInstructions('typescript', 'full');
    expect(out).toContain('framework-aware code intelligence server');
    expect(out).toContain('WHEN TO USE trace-mcp tools:');
    expect(out).toContain('Token optimization');
    expect(out).not.toContain('Agent Behavior');
  });
});

describe('buildInstructions — agent_behavior', () => {
  it('omits behavior block when agentBehavior=off', () => {
    const out = buildInstructions('typescript', 'full', 'off');
    expect(out).not.toContain('Agent Behavior');
    expect(out).not.toContain('No flattery');
    expect(out).not.toContain('Never fabricate');
  });

  it('appends single-line anti-fabrication rule when agentBehavior=minimal', () => {
    const out = buildInstructions('typescript', 'full', 'minimal');
    expect(out).toContain('Agent Behavior');
    expect(out).toContain('Never fabricate');
    // strict-only rules must NOT leak into minimal
    expect(out).not.toContain('No flattery');
    expect(out).not.toContain('two failed attempts');
    expect(out).not.toContain('drive-by refactors');
  });

  it('appends full behavior block when agentBehavior=strict', () => {
    const out = buildInstructions('typescript', 'full', 'strict');
    expect(out).toContain('Agent Behavior (applies to all tasks');
    expect(out).toContain('No flattery');
    expect(out).toContain("Disagree when the user's premise is wrong");
    expect(out).toContain('Never fabricate');
    expect(out).toContain('two plausible interpretations');
    expect(out).toContain('Rewrite vague asks into verifiable goals');
    expect(out).toContain('Never report "done"');
    expect(out).toContain('two failed attempts');
    expect(out).toContain('drive-by refactors');
  });

  it('agent_behavior is orthogonal to verbosity — strict with verbosity=minimal still includes rules', () => {
    const out = buildInstructions('typescript', 'minimal', 'strict');
    expect(out).toContain('trace-mcp: framework-aware code intelligence');
    expect(out).toContain('Agent Behavior');
    expect(out).toContain('No flattery');
  });

  it('agent_behavior still emits when verbosity=none (rules-only mode)', () => {
    const out = buildInstructions('typescript', 'none', 'strict');
    expect(out).not.toContain('WHEN TO USE trace-mcp');
    expect(out).toContain('Agent Behavior');
    expect(out).toContain('No flattery');
  });

  it('defaults agentBehavior to off when parameter omitted', () => {
    const withDefault = buildInstructions('typescript', 'full');
    const explicit = buildInstructions('typescript', 'full', 'off');
    expect(withDefault).toBe(explicit);
  });
});
