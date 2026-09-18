import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { detectMcpClients } from '../mcp-detector';

let home: string;

function writeAmpSettings(content: string): void {
  const dir = path.join(home, '.config', 'amp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.jsonc'), content, 'utf-8');
}

function ampClient() {
  return detectMcpClients(undefined, home).find((c) => c.name === 'amp');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-detector-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

it('reads a configured amp.mcpServers entry out of JSONC with comments', () => {
  writeAmpSettings(`{
  // Sourcegraph AMP settings
  "amp.mcpServers": {
    "trace-mcp": { "command": "trace-mcp", "args": ["serve"] }
  }
}
`);
  expect(ampClient()).toEqual({
    name: 'amp',
    configPath: path.join(home, '.config', 'amp', 'settings.jsonc'),
    hasTraceMcp: true,
  });
});

it('does not count a commented-out entry as a configured server', () => {
  writeAmpSettings(`{
  // "amp.mcpServers": { "trace-mcp": { "command": "trace-mcp" } }
  "amp.notifications.enabled": true
}
`);
  expect(ampClient()?.hasTraceMcp).toBe(false);
});

it('does not count a mention of the key inside a string value', () => {
  writeAmpSettings(`{
  "amp.note": "amp.mcpServers is where trace-mcp would go"
}
`);
  expect(ampClient()?.hasTraceMcp).toBe(false);
});

it('detects a gemini-cli entry in ~/.gemini/settings.json', () => {
  const dir = path.join(home, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ mcpServers: { trace: { command: 'trace', args: ['serve'] } } }),
  );
  expect(
    detectMcpClients(undefined, home).find((c) => c.name === 'gemini-cli'),
  ).toEqual({
    name: 'gemini-cli',
    configPath: path.join(home, '.gemini', 'settings.json'),
    hasTraceMcp: true,
  });
});

/* TRA-1659: Antigravity (`~/.gemini/config/mcp_config.json`) and Gemini CLI
   (`~/.gemini/settings.json`) share the ~/.gemini dir but never the file —
   one client's entry must not light up the other client's row. */
it('does not count an antigravity entry as gemini-cli', () => {
  const dir = path.join(home, '.gemini', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mcp_config.json'),
    JSON.stringify({ mcpServers: { trace: { command: 'trace', args: ['serve'] } } }),
  );
  const clients = detectMcpClients(undefined, home);
  expect(clients.find((c) => c.name === 'antigravity')?.hasTraceMcp).toBe(true);
  expect(clients.find((c) => c.name === 'gemini-cli')).toBeUndefined();
});

it('does not count a gemini-cli entry as antigravity', () => {
  const dir = path.join(home, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ mcpServers: { trace: { command: 'trace', args: ['serve'] } } }),
  );
  const clients = detectMcpClients(undefined, home);
  expect(clients.find((c) => c.name === 'gemini-cli')?.hasTraceMcp).toBe(true);
  expect(clients.find((c) => c.name === 'antigravity')).toBeUndefined();
});
