// @ts-nocheck
import Redis from 'ioredis';

export const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
});

export const cluster = new Redis.Cluster([
  { host: 'node1', port: 6379 },
  { host: 'node2', port: 6379 },
]);
