/**
 * Topic tunnels — pairwise shared-entity links between registered subprojects.
 *
 * Given the entity registry from {@link extractEntities}, this module computes
 * which (project_a, project_b) pairs share at least one canonical entity, and
 * emits a `TopicTunnel` record per pair with the list of shared topics.
 *
 * Mirrors mempalace v3.3.4 cross-wing tunnels (#1184) — but our atom is a
 * subproject in the topology store, and our topics come from manifests + git
 * rather than free-form session content.
 */
import { extractEntities, type Entity, type EntityKind } from './entity-extractor.js';

export interface TopicTunnel {
  project_a: string;
  project_b: string;
  shared: Array<{ kind: EntityKind; canonical: string; display: string }>;
  /**
   * Strength signal: weighted sum of shared entities. People and project
   * names count more than common framework dependencies (which are nearly
   * universal in modern monorepos). Bounded above by 1.0 only after
   * normalisation — raw weight is unbounded.
   */
  weight: number;
}

interface ProjectEntities {
  name: string;
  entities: Entity[];
}

/**
 * Per-kind weight applied when scoring shared entities. Project names are the
 * strongest "this is the same thing" signal; packages (deps) the noisiest.
 */
const KIND_WEIGHT: Record<EntityKind, number> = {
  project: 3,
  person: 2,
  package: 1,
};

/**
 * Common-as-water dependencies that survive the "is this two repos sharing a
 * topic" filter only when paired with another, more specific signal. We don't
 * exclude them outright — they're still useful when two repos share unusual
 * combinations of common deps — but we down-weight to 0.25 of their kind
 * weight.
 */
const COMMON_PACKAGES = new Set([
  'typescript',
  'eslint',
  'prettier',
  'react',
  'vue',
  'lodash',
  'moment',
  'rxjs',
  'jest',
  'mocha',
  'vitest',
  'webpack',
  'rollup',
  'vite',
  'tsup',
  'commander',
  'chalk',
  'zod',
  '@types/node',
]);

function entityWeight(e: Entity): number {
  const base = KIND_WEIGHT[e.kind];
  if (e.kind === 'package' && COMMON_PACKAGES.has(e.canonical)) {
    return base * 0.25;
  }
  return base;
}

export interface DetectTunnelsOptions {
  /** Min raw weight required to surface a tunnel. Default 1. */
  minWeight?: number;
  /** Max number of tunnels returned (highest-weight first). Default 100. */
  limit?: number;
}

/**
 * Compute topic tunnels across a list of (name, repoRoot) subprojects. Reads
 * each repo on demand via {@link extractEntities}; on a cold cache this is
 * O(N) git invocations so callers should batch or cache externally if the
 * registry is large.
 */
export function detectTopicTunnels(
  subprojects: Array<{ name: string; repoRoot: string }>,
  opts: DetectTunnelsOptions = {},
): TopicTunnel[] {
  const minWeight = opts.minWeight ?? 1;
  const limit = opts.limit ?? 100;

  const enriched: ProjectEntities[] = subprojects.map((s) => ({
    name: s.name,
    entities: extractEntities(s.repoRoot),
  }));

  // Build a kind|canonical -> Entity map per project for fast intersect.
  const indexed: Array<{ name: string; map: Map<string, Entity> }> = enriched.map((p) => {
    const map = new Map<string, Entity>();
    for (const e of p.entities) {
      // Skip self-references: a project's own canonical name will trivially
      // match no one else, but it shouldn't act as evidence either when the
      // same name appears as a dep in another project. The shape is fine —
      // the tunnel detector still surfaces the overlap, scored by weight.
      map.set(`${e.kind}|${e.canonical}`, e);
    }
    return { name: p.name, map };
  });

  const tunnels: TopicTunnel[] = [];
  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      const a = indexed[i];
      const b = indexed[j];
      const shared: TopicTunnel['shared'] = [];
      let weight = 0;
      // Iterate over the smaller map for cheaper lookups.
      const [smaller, bigger] = a.map.size <= b.map.size ? [a.map, b.map] : [b.map, a.map];
      for (const [key, e] of smaller) {
        if (bigger.has(key)) {
          shared.push({ kind: e.kind, canonical: e.canonical, display: e.display });
          weight += entityWeight(e);
        }
      }
      if (shared.length === 0 || weight < minWeight) continue;
      tunnels.push({
        project_a: a.name,
        project_b: b.name,
        shared,
        weight: Number(weight.toFixed(2)),
      });
    }
  }

  tunnels.sort((x, y) => y.weight - x.weight);
  return tunnels.slice(0, limit);
}
