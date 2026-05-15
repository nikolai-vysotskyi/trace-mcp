/**
 * Regression tests for the /mcp project resolver.
 *
 * Critical scenario: commit 58e25a2 made the daemon return 400 when an
 * MCP client connects to /mcp without `?project=` and more than one
 * project is registered. Users post-update reported "trace-mcp stopped
 * working" because their stdio bridges / IDE HTTP-MCP integrations
 * cannot append a query string to the bridge URL.
 *
 * resolveProjectForMcpRequest restores connectivity by consulting:
 *   1. ?project= query
 *   2. X-Trace-Project header
 *   3. params._meta["traceMcp/projectRoot"]
 *   4. clientInfo.name -> tracked client lookup
 *   5. single-project shortcut
 * before falling back to "ambiguous". The handler MUST NOT silently
 * pick listProjects()[0].
 */

import { describe, expect, it } from 'vitest';

import {
  extractInitializeClientName,
  extractMetaProjectRoot,
  resolveProjectForMcpRequest,
} from '../../src/daemon/mcp-project-router.js';

const PROJ_A = '/Users/dev/projects/alpha';
const PROJ_B = '/Users/dev/projects/beta';
const TWO_PROJECTS = [{ root: PROJ_A }, { root: PROJ_B }];

describe('resolveProjectForMcpRequest', () => {
  it('returns ambiguous (no silent fallback) when nothing identifies the project', () => {
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: undefined,
      body: undefined,
      projects: TWO_PROJECTS,
      trackedClients: [],
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.registered).toEqual([PROJ_A, PROJ_B]);
    }
  });

  it('uses the ?project= query param when present', () => {
    const result = resolveProjectForMcpRequest({
      queryProject: PROJ_B,
      headerProject: undefined,
      body: undefined,
      projects: TWO_PROJECTS,
      trackedClients: [],
    });
    expect(result).toEqual({ kind: 'resolved', projectRoot: PROJ_B, via: 'query' });
  });

  it('uses the X-Trace-Project header when query is missing', () => {
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: PROJ_A,
      body: undefined,
      projects: TWO_PROJECTS,
      trackedClients: [],
    });
    expect(result).toEqual({ kind: 'resolved', projectRoot: PROJ_A, via: 'header' });
  });

  it('uses params._meta["traceMcp/projectRoot"] from the initialize body', () => {
    // This is the central regression case: daemon has 2 projects, the
    // client posts MCP initialize with no `?project=` but with a valid
    // project hint in `_meta`. Handler must pick the matching project,
    // not 400.
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-ai', version: '1.0' },
        _meta: { 'traceMcp/projectRoot': PROJ_B },
      },
    };
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: undefined,
      body,
      projects: TWO_PROJECTS,
      trackedClients: [],
    });
    expect(result).toEqual({ kind: 'resolved', projectRoot: PROJ_B, via: 'meta' });
  });

  it('recovers via clientInfo.name when exactly one tracked client matches', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '0.42' },
      },
    };
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: undefined,
      body,
      projects: TWO_PROJECTS,
      trackedClients: [
        { name: 'cursor', project: PROJ_A },
        { name: 'claude-ai', project: PROJ_B },
      ],
    });
    expect(result).toEqual({ kind: 'resolved', projectRoot: PROJ_A, via: 'tracked-client' });
  });

  it('falls through to ambiguous when clientInfo.name maps to multiple tracked projects', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '0.42' },
      },
    };
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: undefined,
      body,
      projects: TWO_PROJECTS,
      trackedClients: [
        { name: 'cursor', project: PROJ_A },
        { name: 'cursor', project: PROJ_B },
      ],
    });
    expect(result.kind).toBe('ambiguous');
  });

  it('ignores tracked clients whose project is no longer registered', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '0.42' },
      },
    };
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: undefined,
      body,
      projects: TWO_PROJECTS,
      trackedClients: [{ name: 'cursor', project: '/some/stale/path' }],
    });
    expect(result.kind).toBe('ambiguous');
  });

  it('shortcuts to the only registered project when N=1', () => {
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: undefined,
      body: undefined,
      projects: [{ root: PROJ_A }],
      trackedClients: [],
    });
    expect(result).toEqual({ kind: 'resolved', projectRoot: PROJ_A, via: 'single-project' });
  });

  it('returns no-projects when registry is empty', () => {
    const result = resolveProjectForMcpRequest({
      queryProject: undefined,
      headerProject: undefined,
      body: undefined,
      projects: [],
      trackedClients: [],
    });
    expect(result).toEqual({ kind: 'no-projects' });
  });

  it('precedence: query wins over header wins over meta wins over tracked-client', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '0.42' },
        _meta: { 'traceMcp/projectRoot': '/meta-root' },
      },
    };
    const trackedClients = [{ name: 'cursor', project: '/tracked-root' }];

    expect(
      resolveProjectForMcpRequest({
        queryProject: '/query-root',
        headerProject: '/header-root',
        body,
        projects: [{ root: '/query-root' }],
        trackedClients,
      }),
    ).toEqual({ kind: 'resolved', projectRoot: '/query-root', via: 'query' });

    expect(
      resolveProjectForMcpRequest({
        queryProject: undefined,
        headerProject: '/header-root',
        body,
        projects: TWO_PROJECTS,
        trackedClients,
      }),
    ).toEqual({ kind: 'resolved', projectRoot: '/header-root', via: 'header' });

    expect(
      resolveProjectForMcpRequest({
        queryProject: undefined,
        headerProject: undefined,
        body,
        projects: TWO_PROJECTS,
        trackedClients,
      }),
    ).toEqual({ kind: 'resolved', projectRoot: '/meta-root', via: 'meta' });
  });
});

describe('extractMetaProjectRoot', () => {
  it('returns undefined for non-objects', () => {
    expect(extractMetaProjectRoot(undefined)).toBeUndefined();
    expect(extractMetaProjectRoot(null)).toBeUndefined();
    expect(extractMetaProjectRoot('string')).toBeUndefined();
  });

  it('returns undefined when params._meta is absent', () => {
    expect(extractMetaProjectRoot({ params: {} })).toBeUndefined();
    expect(extractMetaProjectRoot({ params: { _meta: {} } })).toBeUndefined();
  });

  it('reads the namespaced key', () => {
    expect(
      extractMetaProjectRoot({
        params: { _meta: { 'traceMcp/projectRoot': '/foo' } },
      }),
    ).toBe('/foo');
  });

  it('rejects empty strings', () => {
    expect(
      extractMetaProjectRoot({
        params: { _meta: { 'traceMcp/projectRoot': '' } },
      }),
    ).toBeUndefined();
  });
});

describe('extractInitializeClientName', () => {
  it('reads params.clientInfo.name', () => {
    expect(
      extractInitializeClientName({
        method: 'initialize',
        params: { clientInfo: { name: 'cursor' } },
      }),
    ).toBe('cursor');
  });

  it('returns undefined when clientInfo is missing', () => {
    expect(extractInitializeClientName({ method: 'initialize', params: {} })).toBeUndefined();
  });
});
