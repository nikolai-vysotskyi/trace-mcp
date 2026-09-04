/**
 * `tools.description_verbosity` is a token-saving switch, so it has to be
 * verified against the JSON Schema the client actually receives — not against
 * `field.description`. Zod v4 keeps descriptions in `z.globalRegistry`, so the
 * original strip (deleting `_def.description`) cleared the accessor while
 * `z.toJSONSchema` still emitted every word: ~38.7k chars of param prose that
 * a user who explicitly asked for minimal descriptions kept paying for.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applySchemaTransforms, type SchemaTransformConfig } from '../tool-gate-helpers.js';

const cfg = (verbosity: SchemaTransformConfig['descriptionVerbosity']): SchemaTransformConfig => ({
  descriptionVerbosity: verbosity,
  compactSchemas: false,
  descriptionOverrides: {},
  sharedParamOverrides: {},
});

const emitted = (shape: Record<string, z.ZodTypeAny>): string =>
  JSON.stringify(z.toJSONSchema(z.object(shape)));

function transformed(
  shape: Record<string, z.ZodTypeAny>,
  verbosity: SchemaTransformConfig['descriptionVerbosity'],
): Record<string, z.ZodTypeAny> {
  const args: unknown[] = ['demo_tool', 'First sentence. Second sentence.', shape, () => undefined];
  applySchemaTransforms(args, cfg(verbosity));
  return args[2] as Record<string, z.ZodTypeAny>;
}

describe('description_verbosity strips param prose from the emitted schema', () => {
  for (const verbosity of ['minimal', 'none'] as const) {
    it(`removes describe() text at verbosity=${verbosity}`, () => {
      const shape = {
        bare: z.string().describe('bare param prose'),
        opt: z.number().describe('optional param prose').optional(),
        dflt: z.enum(['a', 'b']).describe('defaulted param prose').default('a'),
      };
      const out = emitted(transformed({ ...shape }, verbosity));
      expect(out).not.toContain('param prose');
      expect(out).not.toContain('"description"');
      // Structure survives — only the prose goes.
      expect(out).toContain('"enum":["a","b"]');
      expect(out).toContain('"default":"a"');
    });
  }

  it('keeps param prose at verbosity=full', () => {
    const out = emitted(transformed({ bare: z.string().describe('bare param prose') }, 'full'));
    expect(out).toContain('bare param prose');
  });

  it('leaves a schema constant shared with other tools untouched', () => {
    // The daemon registers many tools — and many sessions — from the same
    // module-level schema objects, so stripping must not mutate them in place.
    const shared = z.string().describe('shared param prose').optional();
    transformed({ shared }, 'minimal');
    expect(emitted({ shared })).toContain('shared param prose');
  });

  it('collapses the tool description to its first sentence at minimal', () => {
    const args: unknown[] = ['demo_tool', 'First sentence. Second sentence.', {}, () => undefined];
    applySchemaTransforms(args, cfg('minimal'));
    expect(args[1]).toBe('First sentence.');
  });

  it('keeps the cross-tool routing sentence at minimal for a family member', () => {
    // TRA-842: the description is the only routing mechanism that reaches every
    // client, so the collapse must not drop the sibling pointer.
    const args: unknown[] = [
      'search',
      'Search symbols by name. Padding sentence. For raw text use search_text. Returns JSON.',
      {},
      () => undefined,
    ];
    applySchemaTransforms(args, cfg('minimal'));
    expect(args[1]).toBe('Search symbols by name. For raw text use search_text.');
  });

  it('drops trailing prose at minimal for a tool in no family', () => {
    const args: unknown[] = [
      'demo_tool',
      'First sentence. For raw text use search_text.',
      {},
      () => undefined,
    ];
    applySchemaTransforms(args, cfg('minimal'));
    expect(args[1]).toBe('First sentence.');
  });
});
