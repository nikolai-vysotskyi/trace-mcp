#!/usr/bin/env tsx
/**
 * TRA-1068 — refresh tests/fixtures/wire/*.json from a real daemon.
 *
 * Five production bugs (TRA-1062, TRA-1064) were a client parsing a field
 * name the daemon never sends. The contract tests in
 * packages/app/src/renderer/tabs/__tests__/*.wire.test.ts and
 * tests/api/symbols-search-query.test.ts catch that class of bug ONLY if the
 * fixtures they run against are the real wire shape, not a hand-typed guess.
 * This script is that capture step, so refreshing it costs one command
 * instead of a manual curl session against a live daemon.
 *
 * It spawns a real `serve-http` daemon (in-process registration would skip
 * the tool-gate layer in src/server/tool-gate-helpers.ts, which wraps a
 * bare-array tool result as `{ data: [...] }` on effectively every call —
 * that wrapping IS part of the contract these fixtures pin), points it at
 * this repo's own checkout, and drives the exact JSON-RPC / REST sequence
 * the renderer uses.
 *
 * Usage:
 *   npx tsx scripts/record-wire-fixtures.ts [--project <root>] [--port <port>]
 *
 * Default --project is this repo's own checkout (dogfooding the same corpus
 * TRA-1062/TRA-1064 were found against).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/fixtures/wire');

function parseArgs(argv: string[]): { project: string; port: number } {
  let project = REPO_ROOT;
  let port = 3799;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') project = path.resolve(argv[++i]);
    else if (argv[i] === '--port') port = Number(argv[++i]);
  }
  return { project, port };
}

async function waitForReady(base: string, project: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        const body = (await res.json()) as { projects: Array<{ root: string; status: string }> };
        const p = body.projects.find((x) => x.root === project);
        if (p?.status === 'ready') return;
      }
    } catch {
      /* daemon not listening yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`daemon did not become ready for ${project} within ${timeoutMs}ms`);
}

async function openSession(base: string, project: string): Promise<string> {
  const res = await fetch(`${base}/mcp?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'record-wire-fixtures', version: '0.1.0' },
      },
    }),
  });
  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('initialize did not return mcp-session-id');
  await res.text();
  await fetch(`${base}/mcp?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  }).then((r) => r.text());
  return sessionId;
}

async function callTool(
  base: string,
  project: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${base}/mcp?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const parsed = JSON.parse(trimmed.slice(5).trim());
    return JSON.parse(parsed.result.content[0].text);
  }
  throw new Error(`no data frame in tools/call response for ${name}: ${raw.slice(0, 300)}`);
}

function writeFixture(name: string, value: unknown): void {
  fs.writeFileSync(path.join(FIXTURES_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote tests/fixtures/wire/${name}`);
}

async function main(): Promise<void> {
  const { project, port } = parseArgs(process.argv.slice(2));
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-record-fixtures-'));

  console.log(`spawning serve-http on :${port} for ${project} ...`);
  const daemon = spawn('npx', ['tsx', 'src/cli.ts', 'serve-http', '--port', String(port)], {
    cwd: project,
    env: { ...process.env, TRACE_MCP_DATA_DIR: dataDir },
    stdio: 'ignore',
  });

  try {
    await waitForReady(base, project);
    const sessionId = await openSession(base, project);
    await callTool(base, project, sessionId, 'load_tools', {
      tools: ['get_pagerank', 'get_risk_hotspots', 'get_symbol'],
    });

    writeFixture(
      'get_pagerank.json',
      await callTool(base, project, sessionId, 'get_pagerank', { limit: 6 }),
    );
    writeFixture(
      'get_risk_hotspots.json',
      await callTool(base, project, sessionId, 'get_risk_hotspots', { limit: 6 }),
    );

    // Pick a real symbol so get_symbol.json and the NOT_FOUND fixture below
    // both exercise the same id — cap source length so the fixture stays small.
    const searchRes = await fetch(
      `${base}/api/projects/symbols?${new URLSearchParams({ project, q: 'ProjectManager', limit: '5' })}`,
    );
    writeFixture('symbols_search.json', await searchRes.json());
    const symbolId = 'src/daemon/project-manager.ts::ProjectManager#class';

    writeFixture(
      'get_symbol.json',
      await callTool(base, project, sessionId, 'get_symbol', { symbol_id: symbolId, max_lines: 1 }),
    );
    writeFixture(
      'get_symbol_wrong_arg_not_found.json',
      await callTool(base, project, sessionId, 'get_symbol', { fqn: symbolId }),
    );
  } finally {
    daemon.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
