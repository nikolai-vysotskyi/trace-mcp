/**
 * Client-call scanner: HTTP call extraction for cross-project API linking.
 *
 * Regression for the real-world Nuxt→Laravel case where most calls go through a
 * `$fetch.create` plugin (`$api(...)`) or a `useApiFetch` composable wrapper, and
 * paths are frequently dynamic (template literals / string concatenation). Those
 * were previously dropped, so the cross-project graph "didn't connect".
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanClientCalls } from '../../src/subproject/scanner.js';
import { createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';

describe('scanClientCalls — Nuxt client patterns', () => {
  let dir: string;

  beforeAll(() => {
    dir = createTmpDir('trace-mcp-scanner-');
    writeFixtureFile(
      dir,
      'app/stores/useAuthStore.ts',
      [
        'const { $api } = useNuxtApp()',
        'export const useAuthStore = () => {',
        '  async function login() { return $api("/login", { method: "POST" }) }',
        '  async function user() { return useApiFetch("/api/user") }',
        '  async function fav(id: number) { return $api(`/api/favorited/participant/${id}`) }',
        '  async function media(id: number) { return $api("/api/favorited/media/" + id) }',
        '  async function get(id: number) { return $api.get(`/api/video/${id}`) }',
        '  return { login, user, fav, media, get }',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => removeTmpDir(dir));

  async function urls(): Promise<string[]> {
    return [...new Set((await scanClientCalls(dir)).map((c) => c.urlPattern))];
  }

  it('captures $api(...) plugin-client calls (literal path)', async () => {
    expect(await urls()).toContain('/login');
  });

  it('captures useApiFetch(...) composable calls', async () => {
    expect(await urls()).toContain('/api/user');
  });

  it('normalizes template-literal interpolation to a {*} param', async () => {
    const u = await urls();
    expect(u).toContain('/api/favorited/participant/{*}');
    expect(u).toContain('/api/video/{*}');
  });

  it('normalizes string concatenation to a {*} param', async () => {
    expect(await urls()).toContain('/api/favorited/media/{*}');
  });

  it('extracts the HTTP method from $api.get(...)', async () => {
    const getCall = (await scanClientCalls(dir)).find((c) => c.urlPattern === '/api/video/{*}');
    expect(getCall?.method).toBe('GET');
  });
});
