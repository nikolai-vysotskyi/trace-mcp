// @ts-nocheck
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();
const publicProcedure = t.procedure;

export const userRouter = t.router({
  getById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return { id: input.id, name: 'John' };
    }),

  create: publicProcedure
    .input(z.object({ name: z.string(), email: z.string() }))
    .mutation(async ({ input }) => {
      return { id: '1', ...input };
    }),

  list: publicProcedure.query(async () => {
    return [{ id: '1', name: 'John' }];
  }),
});

export const postRouter = t.router({
  feed: publicProcedure.query(async () => {
    return [];
  }),

  publish: publicProcedure
    .input(z.object({ title: z.string() }))
    .mutation(async ({ input }) => {
      return { id: '1', title: input.title };
    }),
});

export const appRouter = t.router({
  user: userRouter,
  post: postRouter,
});

export type AppRouter = typeof appRouter;
