#!/usr/bin/env node
/**
 * Prints the advertised tool surface — the tool count an MCP client actually
 * sees in `tools/list`, which is the number `docs/_data/counts.yml` quotes.
 *
 * Registration is gated on config and detected frameworks, so this has to be a
 * real initialize + tools/list round-trip against the built server; there is no
 * static list to count. Run after `pnpm run build`.
 *
 *   pnpm run count:tools [--names]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const showNames = process.argv.includes('--names');

const server = spawn('node', ['dist/cli.js', 'serve'], {
  cwd: repoRoot,
  env: { ...process.env, TRACE_MCP_NO_DAEMON: '1' },
  stdio: ['pipe', 'pipe', 'ignore'],
});

const send = (msg) => server.stdin.write(`${JSON.stringify(msg)}\n`);

const timeout = setTimeout(() => {
  console.error('timed out waiting for tools/list');
  server.kill();
  process.exit(1);
}, 120_000);

let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // server logs interleave on stdout
    }
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }
    if (msg.id === 2) {
      const names = msg.result.tools.map((t) => t.name).sort();
      if (showNames) console.log(names.join('\n'));
      console.log(names.length);
      clearTimeout(timeout);
      server.kill();
      process.exit(0);
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'count-advertised-tools', version: '0' },
  },
});
