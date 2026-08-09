import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { DEFAULT_CONFIG_JSONC } from '../../src/global.js';

describe('DEFAULT_CONFIG_JSONC', () => {
  it('scaffolds tools.* values matching the Zod schema defaults', () => {
    const scaffolded = parse(DEFAULT_CONFIG_JSONC).tools;
    const schemaDefaults = TraceMcpConfigSchema.parse({ tools: {} }).tools;

    expect(scaffolded.preset).toBe(schemaDefaults.preset);
    expect(scaffolded.description_verbosity).toBe(schemaDefaults.description_verbosity);
    expect(scaffolded.instructions_verbosity).toBe(schemaDefaults.instructions_verbosity);
  });
});
