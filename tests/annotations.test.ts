/**
 * Verify that MCP ToolAnnotations are injected into all registered tools.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANNOTATIONS, getToolAnnotations } from '../src/server/tool-annotations.js';

describe('tool-annotations', () => {
  it('returns read-only defaults for unknown tools', () => {
    const ann = getToolAnnotations('nonexistent_tool');
    expect(ann).toEqual(DEFAULT_ANNOTATIONS);
    expect(ann.readOnlyHint).toBe(true);
    expect(ann.destructiveHint).toBe(false);
    expect(ann.idempotentHint).toBe(true);
    expect(ann.openWorldHint).toBe(false);
  });

  it('marks refactoring tools as file-writing', () => {
    for (const tool of ['apply_rename', 'apply_move', 'change_signature', 'extract_function']) {
      const ann = getToolAnnotations(tool);
      expect(ann.readOnlyHint, `${tool} should not be read-only`).toBe(false);
      expect(ann.destructiveHint, `${tool} should not be destructive`).toBe(false);
    }
  });

  it('marks destructive tools correctly', () => {
    for (const tool of ['apply_codemod', 'remove_dead_code']) {
      const ann = getToolAnnotations(tool);
      expect(ann.readOnlyHint, `${tool} should not be read-only`).toBe(false);
      expect(ann.destructiveHint, `${tool} should be destructive`).toBe(true);
    }
  });

  it('marks index-mutating tools as non-read-only but idempotent', () => {
    for (const tool of [
      'reindex',
      'register_edit',
      'embed_repo',
      'subproject_sync',
      'refresh_co_changes',
    ]) {
      const ann = getToolAnnotations(tool);
      expect(ann.readOnlyHint, `${tool} should not be read-only`).toBe(false);
      expect(ann.idempotentHint, `${tool} should be idempotent`).toBe(true);
      expect(ann.destructiveHint, `${tool} should not be destructive`).toBe(false);
    }
  });

  it('marks runtime tools as open-world', () => {
    for (const tool of [
      'get_runtime_profile',
      'get_runtime_call_graph',
      'get_endpoint_analytics',
      'get_runtime_deps',
    ]) {
      const ann = getToolAnnotations(tool);
      expect(ann.openWorldHint, `${tool} should be open-world`).toBe(true);
      expect(ann.readOnlyHint, `${tool} should be read-only`).toBe(true);
    }
  });

  it('marks read-only tools correctly', () => {
    for (const tool of [
      'search',
      'get_outline',
      'get_symbol',
      'get_call_graph',
      'find_usages',
      'get_project_map',
    ]) {
      const ann = getToolAnnotations(tool);
      expect(ann.readOnlyHint, `${tool} should be read-only`).toBe(true);
      expect(ann.idempotentHint, `${tool} should be idempotent`).toBe(true);
      expect(ann.openWorldHint, `${tool} should be closed-world`).toBe(false);
    }
  });

  it('marks add_decision as non-idempotent', () => {
    const ann = getToolAnnotations('add_decision');
    expect(ann.readOnlyHint).toBe(false);
    expect(ann.idempotentHint).toBe(false);
  });
});
