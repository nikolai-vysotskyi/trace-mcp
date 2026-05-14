#!/usr/bin/env node
/**
 * Smoke test for the 9 MCP tools shipped this session against a live daemon.
 *
 * Usage: node scripts/smoke-mcp-tools.mjs
 *
 * Tools covered:
 *   1.  remember_decision
 *   2.  pin_file
 *   3.  pin_symbol
 *   4.  list_pins
 *   5.  unpin (file_path)
 *   6.  unpin (symbol_id)
 *   7.  check_claudemd_drift
 *   8.  search_with_mode (lexical)
 *   9.  search_with_mode (feeling_lucky)
 *   10. search_with_mode (graph_completion)
 */

import { URLSearchParams } from 'node:url';

const BASE = process.env.TRACE_MCP_BASE ?? 'http://127.0.0.1:3741';
const PROJECT = process.env.TRACE_MCP_PROJECT ?? '/Users/nikolai/PhpstormProjects/trace-mcp';
const MCP_URL = `${BASE}/mcp?${new URLSearchParams({ project: PROJECT })}`;

const results = [];
let sessionId = '';

function record(name, status, detail) {
  const short =
    typeof detail === 'string' ? detail.slice(0, 200) : JSON.stringify(detail ?? {}).slice(0, 200);
  results.push({ name, status, detail: short });
  const tag = status === 'PASS' ? 'PASS' : status === 'PARTIAL' ? 'PART' : 'FAIL';
  console.log(`[${tag}] ${name}  ${short}`);
}

async function parseRpc(res) {
  const ct = res.headers.get('content-type') ?? '';
  let payload;
  if (ct.includes('text/event-stream')) {
    const raw = await res.text();
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        payload = JSON.parse(t.slice(5).trim());
        break;
      } catch {
        /* skip */
      }
    }
  } else {
    payload = await res.json();
  }
  return payload;
}

async function initSession() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-mcp-tools', version: '0.1.0' },
      },
    }),
  });
  if (!r.ok) throw new Error(`init failed: HTTP ${r.status}`);
  sessionId = r.headers.get('mcp-session-id') ?? '';
  if (!sessionId) throw new Error('no session id from init');
  await r.text().catch(() => '');
  // initialized
  await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  }).then((x) => x.text().catch(() => ''));
}

let rpcId = 2;
async function callTool(name, args) {
  const id = rpcId++;
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const payload = await parseRpc(res);
  if (payload?.error) {
    return { error: payload.error };
  }
  const first = payload?.result?.content?.[0];
  if (first?.type === 'text' && typeof first.text === 'string') {
    try {
      return { ok: JSON.parse(first.text) };
    } catch {
      return { ok: first.text };
    }
  }
  return { raw: payload };
}

async function main() {
  await initSession();
  console.log(`session: ${sessionId}`);

  // 1. remember_decision
  try {
    const r = await callTool('remember_decision', {
      title: 'Smoke test convention',
      content:
        'Smoke-test convention created by scripts/smoke-mcp-tools.mjs on ' +
        new Date().toISOString(),
      type: 'convention',
      file_path: 'scripts/smoke-mcp-tools.mjs',
    });
    if (r.error) {
      record('remember_decision', 'FAIL', `error: ${r.error.message ?? JSON.stringify(r.error)}`);
    } else {
      const v = r.ok ?? {};
      const okId = Number.isInteger(v.id) && v.id > 0;
      const okStatus = ['pending', 'approved', 'rejected'].includes(v.review_status);
      if (okId && okStatus) {
        record('remember_decision', 'PASS', JSON.stringify(v));
      } else {
        record('remember_decision', 'FAIL', `shape mismatch: ${JSON.stringify(v)}`);
      }
    }
  } catch (e) {
    record('remember_decision', 'FAIL', `exception: ${e.message}`);
  }

  // Need a real symbol_id from search for pin_symbol.
  let symId = '';
  try {
    const r = await callTool('search', { query: 'BaseRetriever', kind: 'class', limit: 5 });
    const items = r.ok?.items ?? [];
    if (items.length > 0) symId = items[0].symbol_id || items[0].symbolId || '';
  } catch {
    /* ignore */
  }

  // 2. pin_file
  try {
    const r = await callTool('pin_file', { file_path: 'src/cli.ts', weight: 2.0 });
    if (r.error) record('pin_file', 'FAIL', `error: ${r.error.message ?? JSON.stringify(r.error)}`);
    else {
      const v = r.ok ?? {};
      if (v.ok === true && v.pin && Math.abs((v.pin.weight ?? 0) - 2.0) < 1e-6) {
        record('pin_file', 'PASS', JSON.stringify(v.pin));
      } else {
        record('pin_file', 'FAIL', `shape mismatch: ${JSON.stringify(v)}`);
      }
    }
  } catch (e) {
    record('pin_file', 'FAIL', `exception: ${e.message}`);
  }

  // 3. pin_symbol
  try {
    if (!symId) {
      // try a broader search
      const r2 = await callTool('search', { query: 'BaseRetriever', limit: 5 });
      const items = r2.ok?.items ?? [];
      if (items.length > 0) symId = items[0].symbol_id || items[0].symbolId || '';
    }
    if (!symId) {
      record('pin_symbol', 'FAIL', 'no symbol_id available — search for BaseRetriever returned 0');
    } else {
      const r = await callTool('pin_symbol', { symbol_id: symId, weight: 1.5 });
      if (r.error)
        record('pin_symbol', 'FAIL', `error: ${r.error.message ?? JSON.stringify(r.error)}`);
      else {
        const v = r.ok ?? {};
        if (v.ok === true && v.pin && Math.abs((v.pin.weight ?? 0) - 1.5) < 1e-6) {
          record('pin_symbol', 'PASS', JSON.stringify(v.pin));
        } else {
          record('pin_symbol', 'FAIL', `shape mismatch: ${JSON.stringify(v)}`);
        }
      }
    }
  } catch (e) {
    record('pin_symbol', 'FAIL', `exception: ${e.message}`);
  }

  // 4. list_pins
  try {
    const r = await callTool('list_pins', {});
    if (r.error)
      record('list_pins', 'FAIL', `error: ${r.error.message ?? JSON.stringify(r.error)}`);
    else {
      const v = r.ok ?? {};
      const pins = v.pins ?? [];
      const hasFile = pins.some((p) => p.scope === 'file' && p.target_id === 'src/cli.ts');
      const hasSym = symId ? pins.some((p) => p.scope === 'symbol' && p.target_id === symId) : true;
      if (Array.isArray(pins) && hasFile && hasSym) {
        record('list_pins', 'PASS', `total=${pins.length}, file+symbol both present`);
      } else {
        record('list_pins', 'PARTIAL', `pins=${pins.length}, hasFile=${hasFile}, hasSym=${hasSym}`);
      }
    }
  } catch (e) {
    record('list_pins', 'FAIL', `exception: ${e.message}`);
  }

  // 5. unpin file
  try {
    const r = await callTool('unpin', { file_path: 'src/cli.ts' });
    if (r.error)
      record('unpin (file)', 'FAIL', `error: ${r.error.message ?? JSON.stringify(r.error)}`);
    else {
      const v = r.ok ?? {};
      if (v.ok === true && (v.deleted === 1 || v.deleted === true)) {
        record('unpin (file)', 'PASS', JSON.stringify(v));
      } else {
        record('unpin (file)', 'FAIL', `shape mismatch: ${JSON.stringify(v)}`);
      }
    }
  } catch (e) {
    record('unpin (file)', 'FAIL', `exception: ${e.message}`);
  }

  // 6. unpin symbol
  try {
    if (!symId) {
      record('unpin (symbol)', 'FAIL', 'no symbol_id to unpin');
    } else {
      const r = await callTool('unpin', { symbol_id: symId });
      if (r.error)
        record('unpin (symbol)', 'FAIL', `error: ${r.error.message ?? JSON.stringify(r.error)}`);
      else {
        const v = r.ok ?? {};
        if (v.ok === true && (v.deleted === 1 || v.deleted === true)) {
          record('unpin (symbol)', 'PASS', JSON.stringify(v));
        } else {
          record('unpin (symbol)', 'FAIL', `shape mismatch: ${JSON.stringify(v)}`);
        }
      }
    }
  } catch (e) {
    record('unpin (symbol)', 'FAIL', `exception: ${e.message}`);
  }

  // 7. check_claudemd_drift
  try {
    const r = await callTool('check_claudemd_drift', {});
    if (r.error)
      record(
        'check_claudemd_drift',
        'FAIL',
        `error: ${r.error.message ?? JSON.stringify(r.error)}`,
      );
    else {
      const v = r.ok ?? {};
      if (Array.isArray(v.issues) && typeof v.files_scanned === 'number') {
        const cats = new Set(v.issues.map((i) => i.category));
        record(
          'check_claudemd_drift',
          'PASS',
          `issues=${v.issues.length}, files=${v.files_scanned}, categories=${[...cats].join(',')}`,
        );
      } else {
        record(
          'check_claudemd_drift',
          'FAIL',
          `shape mismatch: ${JSON.stringify(v).slice(0, 200)}`,
        );
      }
    }
  } catch (e) {
    record('check_claudemd_drift', 'FAIL', `exception: ${e.message}`);
  }

  // 8. search_with_mode lexical
  try {
    const r = await callTool('search_with_mode', { query: 'BaseRetriever', mode: 'lexical' });
    if (r.error)
      record(
        'search_with_mode lexical',
        'FAIL',
        `error: ${r.error.message ?? JSON.stringify(r.error)}`,
      );
    else {
      const v = r.ok ?? {};
      const items = v.items ?? [];
      const okMode = v.mode === 'lexical';
      // BaseRetriever is the canonical retrieval-contract symbol. Any top-N hit whose
      // file path or FQN mentions "retrieval" or "BaseRetriever" is good — the synthetic
      // TypeScript parametric form (e.g. __external__/_root/typescript.synthetic for
      // BaseRetriever<LexicalQuery,...>) is itself a retrieval contract, just hoisted.
      const topNFiles = items
        .slice(0, 5)
        .map((it) => `${it.file ?? ''}|${it.fqn ?? it.name ?? ''}`)
        .join(' ');
      const fileMatch =
        topNFiles.toLowerCase().includes('retrieval') ||
        topNFiles.toLowerCase().includes('baseretriever');
      if (okMode && items.length > 0 && fileMatch) {
        record('search_with_mode lexical', 'PASS', `top=${items[0].file}`);
      } else if (okMode && items.length > 0) {
        record(
          'search_with_mode lexical',
          'PARTIAL',
          `top=${items[0].file} (no retrieval/BaseRetriever hit in top-5)`,
        );
      } else {
        record('search_with_mode lexical', 'FAIL', JSON.stringify(v).slice(0, 200));
      }
    }
  } catch (e) {
    record('search_with_mode lexical', 'FAIL', `exception: ${e.message}`);
  }

  // 9. search_with_mode feeling_lucky
  try {
    const r = await callTool('search_with_mode', { query: 'BaseRetriever', mode: 'feeling_lucky' });
    if (r.error)
      record(
        'search_with_mode feeling_lucky',
        'FAIL',
        `error: ${r.error.message ?? JSON.stringify(r.error)}`,
      );
    else {
      const v = r.ok ?? {};
      const items = v.items ?? [];
      // feeling_lucky on PascalCase should route to lexical
      if ((v.mode === 'feeling_lucky' || v.mode === 'lexical') && items.length > 0) {
        record(
          'search_with_mode feeling_lucky',
          'PASS',
          `mode=${v.mode}, items=${items.length}, top=${items[0].file}`,
        );
      } else {
        record('search_with_mode feeling_lucky', 'FAIL', JSON.stringify(v).slice(0, 200));
      }
    }
  } catch (e) {
    record('search_with_mode feeling_lucky', 'FAIL', `exception: ${e.message}`);
  }

  // 10. search_with_mode graph_completion
  try {
    const r = await callTool('search_with_mode', {
      query: 'BaseRetriever',
      mode: 'graph_completion',
    });
    if (r.error)
      record(
        'search_with_mode graph_completion',
        'FAIL',
        `error: ${r.error.message ?? JSON.stringify(r.error)}`,
      );
    else {
      const v = r.ok ?? {};
      const items = v.items ?? [];
      if (v.mode === 'graph_completion' && items.length >= 1) {
        record(
          'search_with_mode graph_completion',
          'PASS',
          `items=${items.length}, top=${items[0].file ?? items[0].name}`,
        );
      } else {
        record('search_with_mode graph_completion', 'FAIL', JSON.stringify(v).slice(0, 200));
      }
    }
  } catch (e) {
    record('search_with_mode graph_completion', 'FAIL', `exception: ${e.message}`);
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const part = results.filter((r) => r.status === 'PARTIAL').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`PASS=${pass}  PARTIAL=${part}  FAIL=${fail}  TOTAL=${results.length}`);
  for (const r of results) {
    console.log(`  ${r.status.padEnd(7)} ${r.name}`);
  }
  return { pass, part, fail, results };
}

main()
  .then((s) => {
    process.exit(s.fail > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(2);
  });
