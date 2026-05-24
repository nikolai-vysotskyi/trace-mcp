import { describe, expect, it } from 'vitest';
import {
  buildAmbiguousProjectError,
  buildNoProjectsError,
  buildProjectNotFoundError,
  extractRpcId,
} from '../mcp-error-response.js';

// Issue #168: MCP clients were surfacing a cryptic
// "MCP error -32603: Backend send failed: Error POSTing to endpoint:
// {"error":"Project not found: /Users/user"}" because the daemon's 404 body
// wasn't a valid JSON-RPC response and the message gave the user nothing
// actionable. These tests pin the JSON-RPC envelope and the per-branch
// message contents so regressions surface immediately.

describe('extractRpcId', () => {
  it('returns the id from a JSON-RPC body', () => {
    expect(extractRpcId({ jsonrpc: '2.0', id: 7, method: 'initialize' })).toBe(7);
  });

  it('returns null when no id field is present', () => {
    expect(extractRpcId({ jsonrpc: '2.0', method: 'initialize' })).toBeNull();
  });

  it('returns null for non-object bodies', () => {
    expect(extractRpcId(undefined)).toBeNull();
    expect(extractRpcId(null)).toBeNull();
    expect(extractRpcId('garbage')).toBeNull();
  });

  it('coerces an explicit null id to null', () => {
    expect(extractRpcId({ id: null })).toBeNull();
  });
});

describe('buildNoProjectsError', () => {
  it('returns a JSON-RPC envelope with code -32002 and an actionable message', () => {
    const body = buildNoProjectsError(42);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(42);
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toMatch(/No projects registered/i);
    expect(body.error.message).toMatch(/trace-mcp add/);
    expect(body.error.data.reason).toBe('no_projects_registered');
  });

  it('uses null id when caller passes undefined', () => {
    expect(buildNoProjectsError(undefined).id).toBeNull();
  });
});

describe('buildAmbiguousProjectError', () => {
  it('lists the registered roots and surfaces the resolution hints', () => {
    const body = buildAmbiguousProjectError(['/a', '/b'], 1);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('/a');
    expect(body.error.message).toContain('/b');
    expect(body.error.message).toMatch(/\?project=/);
    expect(body.error.message).toMatch(/X-Trace-Project/);
    expect(body.error.data.reason).toBe('ambiguous_project');
    expect(body.error.data.registered).toEqual(['/a', '/b']);
  });
});

describe('buildProjectNotFoundError', () => {
  const base = {
    projectRoot: '/Users/user',
    folderMissing: false,
    dangerReason: null as string | null,
    hasMarkers: true,
    rpcId: 9,
  };

  it('folder_missing — explains deletion and suggests `trace-mcp remove`', () => {
    const body = buildProjectNotFoundError({ ...base, folderMissing: true });
    expect(body.error.code).toBe(-32002);
    expect(body.error.data.reason).toBe('folder_missing');
    expect(body.error.message).toMatch(/no longer exists/);
    expect(body.error.message).toContain('trace-mcp remove /Users/user');
  });

  it('dangerous_root — names the reason and tells the user to point at a real project', () => {
    const body = buildProjectNotFoundError({ ...base, dangerReason: 'home directory' });
    expect(body.error.data.reason).toBe('dangerous_root');
    expect(body.error.message).toContain('home directory');
    expect(body.error.message).toMatch(/package\.json/);
  });

  it('no_project_markers — suggests explicit `trace-mcp add`', () => {
    const body = buildProjectNotFoundError({ ...base, hasMarkers: false });
    expect(body.error.data.reason).toBe('no_project_markers');
    expect(body.error.message).toContain('trace-mcp add /Users/user');
    expect(body.error.message).toMatch(/no package\.json/);
  });

  it('auto_register_failed — the markers-present-but-add-failed fallback', () => {
    const body = buildProjectNotFoundError(base);
    expect(body.error.data.reason).toBe('auto_register_failed');
    expect(body.error.message).toMatch(/Auto-registration failed/);
  });

  it('echoes the JSON-RPC id back', () => {
    expect(buildProjectNotFoundError({ ...base, rpcId: 'req-1' }).id).toBe('req-1');
    expect(buildProjectNotFoundError({ ...base, rpcId: undefined }).id).toBeNull();
  });

  it('folder_missing takes precedence over a dangerous root', () => {
    // If the folder is gone, telling the user "this is a dangerous root" is
    // misleading — they need to clean up the registration first.
    const body = buildProjectNotFoundError({
      ...base,
      folderMissing: true,
      dangerReason: 'home directory',
    });
    expect(body.error.data.reason).toBe('folder_missing');
  });
});
