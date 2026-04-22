// @ts-nocheck
import { Queue, Worker } from 'bullmq';

export const emailQueue = new Queue('email', {
  connection: { host: '127.0.0.1', port: 6379 },
});

export const emailWorker = new Worker(
  'email',
  async (job) => {
    // process job
    return { ok: true, id: job.id };
  },
  { connection: { host: '127.0.0.1', port: 6379 } },
);
