/**
 * `trace-mcp ask` command.
 * Natural language Q&A over any codebase using trace-mcp retrieval + LLM streaming.
 *
 * Usage:
 *   trace-mcp ask "how does authentication work?"
 *   trace-mcp ask --chat                          # multi-turn mode
 *   trace-mcp ask --repo owner/name "where are the API routes?"
 *   trace-mcp ask --model gpt-4o "explain the plugin system"
 */

import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, type TraceMcpConfig } from '../config.js';
import { findProjectRoot, hasRootMarkers } from '../project-root.js';
import { getProject } from '../registry.js';
import { setupProject } from '../project-setup.js';
import { Store } from '../db/store.js';
import { initializeDatabase } from '../db/schema.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { createAllLanguagePlugins } from '../indexer/plugins/language/all.js';
import { createAllIntegrationPlugins } from '../indexer/plugins/integration/all.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import type { ChatMessage } from '../ai/interfaces.js';
import {
  type LLMProvider,
  resolveProvider,
  gatherContext,
  buildSystemPrompt,
  stripContextFromMessage,
} from '../ai/ask-shared.js';

// ---------------------------------------------------------------------------
// Project resolution (local dir or --repo clone)
// ---------------------------------------------------------------------------

interface ProjectContext {
  projectRoot: string;
  config: TraceMcpConfig;
  store: Store;
  pluginRegistry: PluginRegistry;
  cleanup?: () => void;
}

async function resolveProject(repoArg?: string): Promise<ProjectContext> {
  if (repoArg) {
    return resolveRemoteRepo(repoArg);
  }
  return resolveLocalProject();
}

function createPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of createAllLanguagePlugins()) registry.registerLanguagePlugin(p);
  for (const p of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(p);
  return registry;
}

async function resolveLocalProject(): Promise<ProjectContext> {
  const cwd = process.cwd();
  let projectRoot: string;

  try {
    projectRoot = findProjectRoot(cwd);
  } catch {
    if (hasRootMarkers(cwd)) {
      projectRoot = cwd;
    } else {
      throw new Error(`No project found in ${cwd}. Run \`trace-mcp add\` first.`);
    }
  }

  const entry = getProject(projectRoot);
  if (!entry) {
    throw new Error(
      `Project not indexed. Run \`trace-mcp add ${projectRoot}\` first.`,
    );
  }

  const configResult = await loadConfig(projectRoot);
  if (configResult.isErr()) throw new Error(`Config error: ${configResult.error}`);
  const config = configResult.value;

  const db = initializeDatabase(entry.dbPath);
  const store = new Store(db);
  const pluginRegistry = createPluginRegistry();

  return { projectRoot, config, store, pluginRegistry };
}

async function resolveRemoteRepo(repo: string): Promise<ProjectContext> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid repo format: "${repo}". Expected owner/name (e.g. facebook/react)`);
  }

  const tmpDir = `${os.tmpdir()}/trace-mcp-ask-${repo.replace('/', '-')}-${Date.now()}`;

  process.stderr.write(`Cloning ${repo}...\n`);
  execSync(`git clone --depth=1 --single-branch "https://github.com/${repo}.git" "${tmpDir}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const { entry } = setupProject(tmpDir, { force: true });

  const configResult = await loadConfig(tmpDir);
  if (configResult.isErr()) throw new Error(`Config error: ${configResult.error}`);
  const config = configResult.value;

  const db = initializeDatabase(entry.dbPath);
  const store = new Store(db);
  const pluginRegistry = createPluginRegistry();

  process.stderr.write('Indexing...\n');
  const pipeline = new IndexingPipeline(store, pluginRegistry, config);
  const result = await pipeline.run(tmpDir);
  process.stderr.write(`Indexed ${result.indexed} files in ${result.durationMs}ms\n`);

  const cleanup = () => {
    try { store.db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  return { projectRoot: tmpDir, config, store, pluginRegistry, cleanup };
}

// ---------------------------------------------------------------------------
// Single-question mode
// ---------------------------------------------------------------------------

async function askOnce(
  provider: LLMProvider,
  project: ProjectContext,
  question: string,
  budget: number,
): Promise<void> {
  process.stderr.write('Retrieving context...\n');
  const context = await gatherContext(project.projectRoot, project.store, project.pluginRegistry, question, budget);

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(project.projectRoot) },
    {
      role: 'user',
      content: `## Code Context\n\n${context}\n\n## Question\n\n${question}`,
    },
  ];

  for await (const chunk of provider.streamChat(messages, { maxTokens: 4096 })) {
    process.stdout.write(chunk);
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Chat mode
// ---------------------------------------------------------------------------

async function chatLoop(
  provider: LLMProvider,
  project: ProjectContext,
  budget: number,
): Promise<void> {
  const history: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(project.projectRoot) },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\ntrace> ',
  });

  process.stderr.write('trace-mcp chat mode. Type your question (Ctrl+C or /quit to exit).\n');
  rl.prompt();

  for await (const line of rl) {
    const question = line.trim();
    if (!question) {
      rl.prompt();
      continue;
    }

    if (question === '/quit' || question === '/exit') {
      break;
    }

    process.stderr.write('Retrieving context...\n');
    const context = await gatherContext(project.projectRoot, project.store, project.pluginRegistry, question, budget);

    // Strip context from older messages to prevent token bloat
    for (let i = 1; i < history.length; i++) {
      if (history[i].role === 'user') {
        history[i] = stripContextFromMessage(history[i]);
      }
    }

    history.push({
      role: 'user',
      content: `## Code Context\n\n${context}\n\n## Question\n\n${question}`,
    });

    // Keep history manageable — last 10 user/assistant turns + system
    while (history.length > 21) {
      history.splice(1, 2);
    }

    process.stdout.write('\n');
    let fullResponse = '';
    for await (const chunk of provider.streamChat(history, { maxTokens: 4096 })) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }
    process.stdout.write('\n');

    history.push({ role: 'assistant', content: fullResponse });
    rl.prompt();
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// Commander definition
// ---------------------------------------------------------------------------

export const askCommand = new Command('ask')
  .description('Ask questions about your codebase using AI')
  .argument('[question...]', 'Question to ask (or use --chat for interactive mode)')
  .option('--chat', 'Interactive multi-turn chat mode')
  .option('--repo <owner/name>', 'Query a GitHub repository (auto-clones and indexes)')
  .option('--provider <name>', 'LLM provider: groq, anthropic, openai (auto-detects from env)')
  .option('--model <name>', 'Override the LLM model name')
  .option('--budget <tokens>', 'Token budget for context retrieval (default: 12000)', '12000')
  .action(async (questionParts: string[], opts: {
    chat?: boolean;
    repo?: string;
    provider?: string;
    model?: string;
    budget: string;
  }) => {
    const question = questionParts.join(' ').trim();

    if (!opts.chat && !question) {
      console.error('Usage: trace-mcp ask "your question here"');
      console.error('       trace-mcp ask --chat');
      process.exit(1);
    }

    let project: ProjectContext | undefined;
    try {
      project = await resolveProject(opts.repo);

      const provider = resolveProvider(opts, project.config);
      process.stderr.write(`Using ${provider.name}\n`);

      const budget = parseInt(opts.budget, 10) || 12000;

      if (opts.chat) {
        await chatLoop(provider, project, budget);
      } else {
        await askOnce(provider, project, question, budget);
      }
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    } finally {
      project?.store?.db?.close();
      project?.cleanup?.();
    }
  });
