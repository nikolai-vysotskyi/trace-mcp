// @ts-nocheck
import { redis } from './client';

redis.subscribe('events', (err) => {
  if (err) throw err;
});

redis.on('message', (channel, message) => {
  // handle
});

export function broadcast(event: string) {
  return redis.publish('events', event);
}
