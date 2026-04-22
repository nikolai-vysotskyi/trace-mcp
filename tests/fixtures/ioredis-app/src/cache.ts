// @ts-nocheck
import { redis } from './client';

export async function getUser(id: string) {
  const cached = await redis.get(`user:${id}`);
  if (cached) return JSON.parse(cached);
  return null;
}

export async function setUser(id: string, data: unknown) {
  await redis.set(`user:${id}`, JSON.stringify(data));
  await redis.expire(`user:${id}`, 3600);
}

export async function incrViews(id: string) {
  return redis.incr(`views:${id}`);
}
