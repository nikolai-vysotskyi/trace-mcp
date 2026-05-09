/**
 * Entity registry — pulls "topic-shaped" identifiers out of a repo so we can
 * find overlap between subprojects.
 *
 * mempalace v3.3.4 ships cross-wing topic tunnels (#1184) that link projects
 * by what they're *about*: shared frameworks, shared people, shared concept
 * names. This module is the trace-mcp analogue, but anchored in the things a
 * code repo already exposes:
 *   - canonical project name from package.json / composer.json /
 *     pyproject.toml / Cargo.toml / go.mod
 *   - declared dependencies (top-level only — transitive deps don't tell you
 *     what the project is *about*)
 *   - human contributors from `git shortlog -sne`, with bot filtering and
 *     name/email alias dedup (mempalace #1148)
 *
 * Outputs are typed `Entity` records so the tunnel detector can group across
 * repos. Read-only, no side effects.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type EntityKind = 'project' | 'package' | 'person';

export interface Entity {
  kind: EntityKind;
  /** Lowercased, whitespace-trimmed canonical form used for matching. */
  canonical: string;
  /** Original-case display string (best preserved variant we saw). */
  display: string;
  /** Where this entity was sourced from (file path / "git"). */
  source: string;
}

export interface ExtractEntitiesOptions {
  /** Cap on git authors returned (ranked by commit count). Default 25. */
  maxAuthors?: number;
}

const BOT_EMAIL_PATTERNS: RegExp[] = [
  /\[bot\]@/i,
  /^dependabot@/i,
  /^renovate(?:-bot)?@/i,
  /@bots?\.[^.]+/i,
  /noreply\.bot/i,
];

const BOT_NAME_PATTERNS: RegExp[] = [/\bbot\b/i, /\bdependabot\b/i, /\brenovate\b/i];

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractFromPackageJson(repoRoot: string): Entity[] {
  const pkg = readJsonSafe(path.join(repoRoot, 'package.json'));
  if (!pkg) return [];
  const out: Entity[] = [];
  if (typeof pkg.name === 'string' && pkg.name.length > 0) {
    out.push({
      kind: 'project',
      canonical: pkg.name.toLowerCase(),
      display: pkg.name,
      source: 'package.json',
    });
  }
  for (const field of ['dependencies', 'peerDependencies'] as const) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps)) {
        out.push({
          kind: 'package',
          canonical: name.toLowerCase(),
          display: name,
          source: `package.json:${field}`,
        });
      }
    }
  }
  return out;
}

function extractFromComposerJson(repoRoot: string): Entity[] {
  const comp = readJsonSafe(path.join(repoRoot, 'composer.json'));
  if (!comp) return [];
  const out: Entity[] = [];
  if (typeof comp.name === 'string' && comp.name.length > 0) {
    out.push({
      kind: 'project',
      canonical: comp.name.toLowerCase(),
      display: comp.name,
      source: 'composer.json',
    });
  }
  const require_ = comp.require;
  if (require_ && typeof require_ === 'object') {
    for (const name of Object.keys(require_)) {
      out.push({
        kind: 'package',
        canonical: name.toLowerCase(),
        display: name,
        source: 'composer.json:require',
      });
    }
  }
  return out;
}

function extractFromPyprojectToml(repoRoot: string): Entity[] {
  const filePath = path.join(repoRoot, 'pyproject.toml');
  if (!fs.existsSync(filePath)) return [];
  // Tiny, regex-only TOML scan — we only need [project].name and the top-level
  // dependencies block; bringing in a full TOML parser for two fields is
  // overkill (and we already pin yaml; not toml).
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: Entity[] = [];
  const nameMatch = raw.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m);
  if (nameMatch) {
    out.push({
      kind: 'project',
      canonical: nameMatch[1].toLowerCase(),
      display: nameMatch[1],
      source: 'pyproject.toml',
    });
  }
  // Best-effort: pull dependency strings from the dependencies = [...] block.
  const depsBlock = raw.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (depsBlock) {
    const items = depsBlock[1].match(/"([^"<>=!~^\s]+)/g) ?? [];
    for (const it of items) {
      const name = it.replace(/^"/, '').toLowerCase();
      out.push({
        kind: 'package',
        canonical: name,
        display: name,
        source: 'pyproject.toml:dependencies',
      });
    }
  }
  return out;
}

function extractFromCargoToml(repoRoot: string): Entity[] {
  const filePath = path.join(repoRoot, 'Cargo.toml');
  if (!fs.existsSync(filePath)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: Entity[] = [];
  const nameMatch = raw.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m);
  if (nameMatch) {
    out.push({
      kind: 'project',
      canonical: nameMatch[1].toLowerCase(),
      display: nameMatch[1],
      source: 'Cargo.toml',
    });
  }
  return out;
}

function extractFromGoMod(repoRoot: string): Entity[] {
  const filePath = path.join(repoRoot, 'go.mod');
  if (!fs.existsSync(filePath)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: Entity[] = [];
  const moduleMatch = raw.match(/^\s*module\s+(\S+)/m);
  if (moduleMatch) {
    out.push({
      kind: 'project',
      canonical: moduleMatch[1].toLowerCase(),
      display: moduleMatch[1],
      source: 'go.mod',
    });
  }
  return out;
}

function isBot(name: string, email: string): boolean {
  return (
    BOT_EMAIL_PATTERNS.some((rx) => rx.test(email)) || BOT_NAME_PATTERNS.some((rx) => rx.test(name))
  );
}

interface AuthorAggregate {
  display: string;
  emails: Set<string>;
  commits: number;
}

function extractGitAuthors(repoRoot: string, maxAuthors: number): Entity[] {
  let raw: string;
  try {
    raw = execSync('git shortlog -sne --no-merges HEAD', {
      cwd: repoRoot,
      encoding: 'utf-8',
      // shell out to git; suppress its stderr so a non-git repo doesn't spam logs
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return [];
  }

  // Each line: "  123\tName <email@host>"
  const aggregates = new Map<string, AuthorAggregate>();
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s+<([^>]+)>\s*$/);
    if (!m) continue;
    const commits = Number.parseInt(m[1], 10);
    const name = m[2].trim();
    const email = m[3].trim().toLowerCase();
    if (isBot(name, email)) continue;

    // Union-find dedup: prefer email as the key, fall back to lowercased name.
    // mempalace #1148 also collapses by name when an author committed under
    // multiple emails — we do the cheaper "email OR name" key which catches
    // the common cases without a full union-find pass.
    const lowerName = name.toLowerCase();
    const existing = aggregates.get(email) ?? aggregates.get(lowerName);
    if (existing) {
      existing.commits += commits;
      existing.emails.add(email);
      // keep the longer (more "complete") display
      if (name.length > existing.display.length) existing.display = name;
    } else {
      const agg: AuthorAggregate = {
        display: name,
        emails: new Set([email]),
        commits,
      };
      aggregates.set(email, agg);
      aggregates.set(lowerName, agg);
    }
  }

  // Deduplicate the map (since both keys point at the same object)
  const seen = new Set<AuthorAggregate>();
  const ranked: AuthorAggregate[] = [];
  for (const v of aggregates.values()) {
    if (seen.has(v)) continue;
    seen.add(v);
    ranked.push(v);
  }
  ranked.sort((a, b) => b.commits - a.commits);

  return ranked.slice(0, maxAuthors).map((a) => ({
    kind: 'person' as const,
    canonical: a.display.toLowerCase(),
    display: a.display,
    source: 'git',
  }));
}

/**
 * Pull manifest + git entities from `repoRoot`. Empty-array on missing repo
 * (function never throws — bad input degrades to "no entities surfaced").
 */
export function extractEntities(repoRoot: string, opts: ExtractEntitiesOptions = {}): Entity[] {
  const maxAuthors = opts.maxAuthors ?? 25;
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) return [];

  const out: Entity[] = [];
  out.push(...extractFromPackageJson(repoRoot));
  out.push(...extractFromComposerJson(repoRoot));
  out.push(...extractFromPyprojectToml(repoRoot));
  out.push(...extractFromCargoToml(repoRoot));
  out.push(...extractFromGoMod(repoRoot));
  out.push(...extractGitAuthors(repoRoot, maxAuthors));

  // Dedup by (kind, canonical) — preserves the first display we saw.
  const seen = new Set<string>();
  const deduped: Entity[] = [];
  for (const e of out) {
    const key = `${e.kind}:${e.canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  return deduped;
}
