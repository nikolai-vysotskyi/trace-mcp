import fs from 'node:fs';
import path from 'node:path';
import type { ProjectContext } from '../../../../plugin-api/types.js';
import { escapeRegExp } from '../../../../utils/security.js';

export function hasPythonDep(ctx: ProjectContext, pkg: string): boolean {
  const lower = pkg.toLowerCase();

  if (ctx.pyprojectToml) {
    const deps = ctx.pyprojectToml._parsedDeps as string[] | undefined;
    if (deps?.includes(lower)) return true;
  }

  if (ctx.requirementsTxt?.includes(lower)) return true;

  try {
    const content = fs.readFileSync(path.join(ctx.rootPath, 'pyproject.toml'), 'utf-8');
    if (new RegExp(`["']${escapeRegExp(pkg)}[>=<\\[!~\\s"']`, 'i').test(content)) return true;
  } catch { /* not found */ }

  try {
    const content = fs.readFileSync(path.join(ctx.rootPath, 'requirements.txt'), 'utf-8');
    if (new RegExp(`^${escapeRegExp(pkg)}\\b`, 'im').test(content)) return true;
  } catch { /* not found */ }

  return false;
}

export function hasAnyPythonDep(ctx: ProjectContext, pkgs: readonly string[]): boolean {
  for (const p of pkgs) if (hasPythonDep(ctx, p)) return true;
  return false;
}
