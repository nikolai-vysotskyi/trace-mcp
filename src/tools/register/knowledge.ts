/**
 * Knowledge Agent tools — persistent code corpora + Q&A against them.
 *
 *   build_corpus   pack project / module / feature scope into a saved corpus
 *   list_corpora   show all corpora on disk
 *   query_corpus   answer a natural-language question against a corpus
 *   delete_corpus  remove a corpus (manifest + body)
 *
 * Inspired by claude-mem v12.1 ("Knowledge Agents"); built on top of our
 * existing `packContext` (storage shipped in 6425e26 / 5e34f59).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CorpusBuildError, buildCorpus } from '../../memory/corpus-builder.js';
import {
  CorpusStore,
  CorpusValidationError,
  validateCorpusName,
} from '../../memory/corpus-store.js';
import type { ServerContext } from '../../server/types.js';

const NAME_SCHEMA = z
  .string()
  .min(1)
  .max(64)
  .describe(
    'Corpus slug — alphanumeric + dash + underscore, ≤64 chars, must start with a letter or digit',
  );

const SCOPE_SCHEMA = z
  .enum(['project', 'module', 'feature'])
  .describe('Pack scope: project (whole repo), module (subdirectory), feature (NL query rank)');

const STRATEGY_SCHEMA = z
  .enum(['most_relevant', 'core_first', 'compact'])
  .describe(
    'Pack strategy: most_relevant (default; feature/PageRank ranked), core_first (PageRank wins, surfaces architecturally central code), compact (signatures only — drops source bodies, lets outlines cover much more of the repo per token)',
  );

export function registerKnowledgeTools(server: McpServer, ctx: ServerContext): void {
  const { projectRoot, store, registry, j, aiProvider } = ctx;
  const corpora = new CorpusStore();

  // ── build_corpus ───────────────────────────────────────────────────

  server.tool(
    'build_corpus',
    'Pack a slice of project context into a persistent corpus on disk so future query_corpus calls can prime an LLM with the same snapshot without re-running the pack pipeline. Mutates the corpora store; returns JSON with the saved manifest. Pair with query_corpus for "ask this codebase" workflows.',
    {
      name: NAME_SCHEMA,
      scope: SCOPE_SCHEMA,
      module_path: z
        .string()
        .max(512)
        .optional()
        .describe('Subdirectory path when scope=module (e.g. "src/auth")'),
      feature_query: z
        .string()
        .max(500)
        .optional()
        .describe('Natural-language query when scope=feature (e.g. "JWT auth and refresh flow")'),
      token_budget: z
        .number()
        .int()
        .min(1_000)
        .max(200_000)
        .optional()
        .describe('Token budget for the packed body (default 50000)'),
      pack_strategy: STRATEGY_SCHEMA.optional(),
      description: z
        .string()
        .max(500)
        .optional()
        .describe('Optional human-readable description stored on the manifest'),
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace an existing corpus with the same name (default false)'),
    },
    async ({
      name,
      scope,
      module_path,
      feature_query,
      token_budget,
      pack_strategy,
      description,
      overwrite,
    }) => {
      try {
        const manifest = buildCorpus(
          { store, registry, corpora },
          {
            name,
            projectRoot,
            scope,
            modulePath: module_path,
            featureQuery: feature_query,
            tokenBudget: token_budget,
            packStrategy: pack_strategy,
            description,
            overwrite,
          },
        );
        return { content: [{ type: 'text', text: j({ saved: manifest }) }] };
      } catch (err) {
        if (err instanceof CorpusValidationError || err instanceof CorpusBuildError) {
          return {
            isError: true,
            content: [{ type: 'text', text: j({ error: err.message, kind: err.name }) }],
          };
        }
        throw err;
      }
    },
  );

  // ── list_corpora ───────────────────────────────────────────────────

  server.tool(
    'list_corpora',
    'List every corpus saved on disk with its manifest (scope, project_root, sizes, timestamps). Read-only. Use to discover what corpora are available to query.',
    {},
    async () => {
      const items = corpora.list();
      return {
        content: [{ type: 'text', text: j({ corpora: items, total: items.length }) }],
      };
    },
  );

  // ── query_corpus ───────────────────────────────────────────────────

  server.tool(
    'query_corpus',
    'Answer a natural-language question against a saved corpus. Loads the corpus body, primes the configured AI provider with it as system context, and returns the response. When mode="prompt-only" returns the assembled system+user prompt instead of calling the AI — useful for users without an AI provider configured, or for piping into another LLM. Returns JSON: { answer | prompt, corpus, tokens_used }.',
    {
      name: NAME_SCHEMA,
      question: z.string().min(1).max(2_000).describe('Natural-language question'),
      mode: z
        .enum(['answer', 'prompt-only'])
        .optional()
        .describe(
          'answer (default): call the AI provider and return its reply; prompt-only: return the assembled prompt without calling the AI',
        ),
      max_tokens: z
        .number()
        .int()
        .min(64)
        .max(8_192)
        .optional()
        .describe('Cap on the AI response length (default 1024)'),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe('Sampling temperature for the AI call (default 0.2)'),
    },
    async ({ name, question, mode, max_tokens, temperature }) => {
      try {
        validateCorpusName(name);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: j({ error: (err as Error).message, kind: 'CorpusValidationError' }),
            },
          ],
        };
      }

      const manifest = corpora.load(name);
      const body = corpora.loadPackedBody(name);
      if (!manifest || body === null) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: j({ error: `Corpus "${name}" not found`, hint: 'Run build_corpus first' }),
            },
          ],
        };
      }

      const systemPrompt =
        `You are answering questions about a specific code corpus. Use ONLY the ` +
        `provided context to answer; if the answer is not in the context, say so ` +
        `plainly. Cite file paths from the context when referencing code.\n\n` +
        `--- BEGIN CORPUS ${name} (project: ${manifest.projectRoot}, scope: ` +
        `${manifest.scope}) ---\n${body}\n--- END CORPUS ---`;

      const composedPrompt = `${systemPrompt}\n\nQuestion: ${question}\n\nAnswer:`;

      const wantPromptOnly = mode === 'prompt-only';
      if (wantPromptOnly) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                corpus: manifest.name,
                prompt: composedPrompt,
                approx_tokens: Math.ceil(composedPrompt.length / 4),
              }),
            },
          ],
        };
      }

      const available = await aiProvider.isAvailable();
      if (!available) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: j({
                error: 'No AI provider available; configure one or pass mode="prompt-only"',
              }),
            },
          ],
        };
      }

      try {
        const answer = await aiProvider.inference().generate(composedPrompt, {
          maxTokens: max_tokens ?? 1024,
          temperature: temperature ?? 0.2,
        });
        return {
          content: [
            {
              type: 'text',
              text: j({
                corpus: manifest.name,
                answer,
                corpus_tokens: manifest.estimatedTokens,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: j({
                error: (err as Error).message,
                hint: 'AI provider call failed; try mode="prompt-only" to inspect the prompt',
              }),
            },
          ],
        };
      }
    },
  );

  // ── delete_corpus ──────────────────────────────────────────────────

  server.tool(
    'delete_corpus',
    'Remove a saved corpus (manifest + packed body). Returns JSON: { deleted: bool, name }.',
    {
      name: NAME_SCHEMA,
    },
    async ({ name }) => {
      try {
        const removed = corpora.delete(name);
        return { content: [{ type: 'text', text: j({ deleted: removed, name }) }] };
      } catch (err) {
        if (err instanceof CorpusValidationError) {
          return {
            isError: true,
            content: [{ type: 'text', text: j({ error: err.message }) }],
          };
        }
        throw err;
      }
    },
  );
}
