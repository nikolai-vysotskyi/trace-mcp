import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const decisionTypeSchema = z.enum([
  'architecture_decision',
  'tech_choice',
  'bug_root_cause',
  'preference',
  'tradeoff',
  'discovery',
  'convention',
]);

export const traceUiRpcContract = defineRpcContract({
  readOverview: {
    input: z
      .object({ threadId: z.string().min(1), search: z.string().max(500).optional() })
      .strict(),
    output: z
      .object({
        index: z
          .object({
            status: z.string(),
            files: z.number().int().nonnegative(),
            symbols: z.number().int().nonnegative(),
            warnings: z.array(z.string()),
          })
          .strict(),
        indexError: z.string().nullable(),
        context: z
          .object({
            usedTokens: z.number().nonnegative(),
            modelContextWindow: z.number().positive(),
            estimated: z.boolean(),
          })
          .strict()
          .nullable(),
        decisions: z.array(
          z
            .object({
              id: z.string(),
              title: z.string(),
              type: z.string(),
              summary: z.string().nullable(),
            })
            .strict(),
        ),
        decisionsError: z.string().nullable(),
      })
      .strict(),
  },
  saveDecision: {
    input: z
      .object({
        threadId: z.string().min(1),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(5000),
        type: decisionTypeSchema,
      })
      .strict(),
    output: z.object({ id: z.string().min(1) }).strict(),
  },
  reindex: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        status: z.string(),
        indexed: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
      })
      .strict(),
  },
});
