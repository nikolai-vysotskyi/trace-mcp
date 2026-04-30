import { describe, expect, it } from 'vitest';
import { AnthropicSdkPlugin } from '../../../src/indexer/plugins/integration/tooling/anthropic-sdk/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function ctx(deps: Record<string, string>): ProjectContext {
  return {
    rootPath: '/tmp',
    packageJson: { dependencies: deps },
    detectedVersions: [],
    allDependencies: [],
    configFiles: [],
  };
}

async function extract(
  plugin: AnthropicSdkPlugin,
  code: string,
  filePath = 'src/llm.ts',
  language = 'typescript',
) {
  const r = await plugin.extractNodes(filePath, Buffer.from(code), language);
  if (!r.isOk()) throw new Error(JSON.stringify(r._unsafeUnwrapErr()));
  return r._unsafeUnwrap();
}

describe('AnthropicSdkPlugin', () => {
  const plugin = new AnthropicSdkPlugin();

  it('manifest', () => {
    expect(plugin.manifest.name).toBe('anthropic-sdk');
  });

  it('detects @anthropic-ai/sdk', () => {
    expect(plugin.detect(ctx({ '@anthropic-ai/sdk': '^0.30.0' }))).toBe(true);
    expect(plugin.detect(ctx({ '@anthropic-ai/vertex-sdk': '^0.5.0' }))).toBe(true);
    expect(plugin.detect(ctx({ openai: '^4.0.0' }))).toBe(false);
  });

  it('extracts messages.create with model', async () => {
    const r = await extract(
      plugin,
      `
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const resp = await client.messages.create({
  model: "claude-3-5-sonnet-latest",
  max_tokens: 1024,
  messages: [],
});
`,
    );
    expect(r.frameworkRole).toBe('llm_client');
    const e = r.edges!.find((x) => x.metadata?.kind === 'messages');
    expect(e).toBeDefined();
    expect(e!.metadata?.provider).toBe('anthropic');
    expect(e!.metadata?.model).toBe('claude-3-5-sonnet-latest');
  });

  it('extracts messages.stream', async () => {
    const r = await extract(
      plugin,
      `
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const stream = client.messages.stream({ model: "claude-3-haiku-20240307", messages: [] });
`,
    );
    expect(r.edges!.some((e) => e.metadata?.kind === 'messages_stream')).toBe(true);
  });

  it('extracts batches.create', async () => {
    const r = await extract(
      plugin,
      `
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
await client.beta.messages.batches.create({ requests: [] });
`,
    );
    expect(r.edges!.some((e) => e.metadata?.kind === 'batch')).toBe(true);
  });

  it('extracts countTokens', async () => {
    const r = await extract(
      plugin,
      `
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
await client.messages.countTokens({ model: 'claude-3-5-sonnet-latest', messages: [] });
`,
    );
    expect(r.edges!.some((e) => e.metadata?.kind === 'count_tokens')).toBe(true);
  });

  it('detects vertex/bedrock variants via import path', async () => {
    const r = await extract(
      plugin,
      `
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
const client = new AnthropicVertex();
await client.messages.create({ model: 'claude-3-5-sonnet@20240620', messages: [] });
`,
    );
    expect(r.edges!.some((e) => e.metadata?.kind === 'messages')).toBe(true);
  });

  it('skips files without @anthropic-ai/sdk import', async () => {
    const r = await extract(plugin, `export const x = 1;`);
    expect(r.edges ?? []).toEqual([]);
  });
});
