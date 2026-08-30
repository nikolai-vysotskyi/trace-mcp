import { describe, expect, it } from 'vitest';
import { reachableSubprojects } from '../subproject-search.js';

const repo = (repo_root: string, project_root: string) => ({ repo_root, project_root });

describe('reachableSubprojects (TRA-470)', () => {
  const repos = [
    repo('/work/shop/api', '/work/shop'),
    repo('/work/shop/web', '/work/shop'),
    repo('/other/client-a', '/other'),
    repo('/other/client-b', '/other'),
  ];

  it('keeps only subprojects registered under the requested project root', () => {
    expect(reachableSubprojects(repos, '/work/shop').map((r) => r.repo_root)).toEqual([
      '/work/shop/api',
      '/work/shop/web',
    ]);
  });

  it('keeps siblings when the requested root is itself a registered subproject', () => {
    expect(reachableSubprojects(repos, '/work/shop/api').map((r) => r.repo_root)).toEqual([
      '/work/shop/api',
      '/work/shop/web',
    ]);
  });

  it('returns nothing for an unrelated project root', () => {
    expect(reachableSubprojects(repos, '/tmp/scratch')).toEqual([]);
  });

  it('ignores trailing slashes on either side', () => {
    expect(reachableSubprojects([repo('/work/shop/api/', '/work/shop/')], '/work/shop')).toHaveLength(
      1,
    );
  });
});
