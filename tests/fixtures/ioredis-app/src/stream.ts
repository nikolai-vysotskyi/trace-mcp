// @ts-nocheck
import { redis } from './client';

export async function appendEvent(event: unknown) {
  return redis.xadd('events-stream', '*', 'data', JSON.stringify(event));
}

export async function readEvents(lastId = '0') {
  return redis.xread('BLOCK', 0, 'STREAMS', 'events-stream', lastId);
}
