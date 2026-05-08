/**
 * `trace-mcp detect-llm` — probe localhost for Ollama / LM Studio / llama.cpp
 * and surface a config snippet the user can paste into trace-mcp.config.json.
 *
 * Read-only: no files written, no network egress beyond localhost. Exits with
 * code 0 when something was reachable, 1 when nothing answered.
 */
import { Command } from 'commander';
import { detectLocalLlm } from '../ai/detect-local.js';

interface Options {
  json?: boolean;
  timeout?: string;
}

export const detectLlmCommand = new Command('detect-llm')
  .description(
    'Probe localhost for Ollama, LM Studio, and llama.cpp. ' +
      'Prints the first reachable provider and a config snippet to enable it.',
  )
  .option('--json', 'machine-readable JSON output')
  .option('--timeout <ms>', 'per-endpoint probe timeout (ms)', '800')
  .action(async (opts: Options) => {
    const timeoutMs = Math.max(50, Number.parseInt(opts.timeout ?? '800', 10) || 800);
    const result = await detectLocalLlm({ timeoutMs });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(result.recommended ? 0 : 1);
    }

    const lines: string[] = [];
    lines.push('Local LLM probe');
    lines.push('─'.repeat(40));
    for (const p of result.probes) {
      const status = p.reachable
        ? `OK   (${p.latencyMs} ms${p.models.length > 0 ? `, models: ${p.models.slice(0, 3).join(', ')}${p.models.length > 3 ? '…' : ''}` : ''})`
        : `miss (${p.error ?? 'no response'})`;
      lines.push(`  ${p.kind.padEnd(11)} ${p.baseUrl.padEnd(28)} ${status}`);
    }
    if (result.recommended) {
      lines.push('');
      lines.push(`Recommended provider: ${result.recommended.kind}`);
      lines.push('Drop this into trace-mcp.config.json:');
      lines.push('');
      lines.push(JSON.stringify(result.configSnippet, null, 2));
    } else {
      lines.push('');
      lines.push('No local LLM endpoint answered.');
      lines.push('Install one of:');
      lines.push('  - Ollama        https://ollama.com         (port 11434)');
      lines.push('  - LM Studio     https://lmstudio.ai        (port 1234)');
      lines.push('  - llama.cpp     server --api               (port 8080)');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(result.recommended ? 0 : 1);
  });
