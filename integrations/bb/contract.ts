import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const traceHostContract = defineRpcContract({
  call: {
    input: z
      .object({
        path: z.string().min(1),
        name: z.string().regex(/^[a-z][a-z0-9_]*$/),
        args: z.record(z.string(), z.unknown()),
      })
      .strict(),
    output: z
      .object({
        content: z.array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('text'), text: z.string() }),
            z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
          ]),
        ),
        isError: z.boolean(),
      })
      .strict(),
  },
  list: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z
      .object({
        tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
      })
      .strict(),
  },
});
