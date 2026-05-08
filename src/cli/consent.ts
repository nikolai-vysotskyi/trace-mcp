/**
 * `trace-mcp consent` — manage outbound LLM consent.
 *
 * Subcommands:
 *   trace-mcp consent grant <provider>   — record consent for the provider
 *   trace-mcp consent revoke <provider>  — remove a previously-granted consent
 *   trace-mcp consent list               — print all granted providers
 *
 * Read/write only `~/.trace-mcp/consent.json`; no network egress, no
 * credentials handled. Mirrors mempalace #1233.
 */
import { Command } from 'commander';
import { grantConsent, listConsent, revokeConsent, REMOTE_PROVIDERS } from '../ai/consent.js';

const KNOWN = REMOTE_PROVIDERS.join(', ');

export const consentCommand = new Command('consent')
  .description('Manage consent for outbound LLM provider traffic.')
  .addCommand(
    new Command('grant')
      .description(`Record consent for a remote LLM provider. Known providers: ${KNOWN}.`)
      .argument('<provider>', 'Provider name (e.g. openai, anthropic, voyage)')
      .action((provider: string) => {
        const lower = provider.toLowerCase();
        if (!(REMOTE_PROVIDERS as readonly string[]).includes(lower)) {
          process.stderr.write(
            `warning: "${provider}" is not in the known-providers list (${KNOWN}). Recording anyway.\n`,
          );
        }
        const record = grantConsent(lower);
        process.stdout.write(`Granted consent for ${lower} at ${record.granted_at}\n`);
      }),
  )
  .addCommand(
    new Command('revoke')
      .description('Remove a previously-granted consent record.')
      .argument('<provider>', 'Provider name')
      .action((provider: string) => {
        const ok = revokeConsent(provider.toLowerCase());
        if (!ok) {
          process.stderr.write(`No consent record for ${provider}\n`);
          process.exit(1);
        }
        process.stdout.write(`Revoked consent for ${provider}\n`);
      }),
  )
  .addCommand(
    new Command('list')
      .description('List all providers that currently have persisted consent.')
      .option('--json', 'machine-readable JSON output')
      .action((opts: { json?: boolean }) => {
        const list = listConsent();
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
          return;
        }
        const entries = Object.entries(list);
        if (entries.length === 0) {
          process.stdout.write(
            'No consent records yet. Local providers (ollama / onnx / lmstudio / llama-cpp) ' +
              'never need consent; remote providers do.\n',
          );
          return;
        }
        for (const [provider, record] of entries.sort(([a], [b]) => a.localeCompare(b))) {
          process.stdout.write(
            `  ${provider.padEnd(12)} granted ${record.granted_at} (by ${record.granted_by})\n`,
          );
        }
      }),
  );
