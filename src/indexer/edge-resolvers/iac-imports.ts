/**
 * Pass 2: Resolve IaC (Kustomize + docker-compose) `imports` edges whose target
 * is a path STRING to the actual manifest / Dockerfile graph node.
 *
 * The YAML plugin emits `imports` edges for:
 *   - Kustomize `resources` / `bases` / `components` / `patchesStrategicMerge` /
 *     `crds` entries — `metadata = { dialect: 'kustomize', module: <path>, ... }`
 *   - docker-compose service `build:` context / Dockerfile —
 *     `metadata = { dialect: 'docker-compose', buildLink: true, module: <path> }`
 *
 * At extraction time only the source symbol is known; the target is a path
 * relative to the source file's directory, which cannot be resolved to a node
 * until every file in the project is indexed. `storeRawEdges` therefore stored
 * those edges as source→source self-loops (target unresolved → `tgt = src`),
 * which pollute PageRank / impact counts and carry zero cross-file signal.
 *
 * This resolver runs after all files are indexed, walks those self-loop edges,
 * resolves `metadata.module` against the source file's directory to a target
 * file (Kustomize) or Dockerfile (compose), and rewrites the edge to point at
 * the resolved node — a single K8s Resource symbol node when the target file has
 * exactly one, otherwise the target file node. Refs that resolve to a directory
 * are mapped to that directory's `kustomization.yaml` (Kustomize) or a
 * `Dockerfile` inside it (compose). Genuinely dangling refs (target not in the
 * index) leave the source with no import edge rather than a bogus self-loop.
 *
 * Scoped-down first cut: only same-project relative paths are resolved. Refs
 * that escape the project root, or point at files that were not indexed, are
 * left unresolved (self-loop dropped). See summary notes for residual gaps.
 */
import path from 'node:path';
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

/** Dialects whose `imports` edges carry a path-string target in metadata.module. */
const IAC_DIALECTS = new Set(['kustomize', 'docker-compose', 'terraform']);

interface SelfLoopImport {
  edgeId: number;
  sourceNodeId: number;
  sourceRefId: number; // symbol id of the source (kustomization Module / compose service)
  module: string;
  dialect: string;
  metadata: Record<string, unknown>;
}

/** Normalise a repo-relative path to forward-slash and collapse `.`/`..`. */
function normalizeRel(p: string): string {
  const posix = p.split(path.sep).join('/');
  // path.posix.normalize keeps a trailing slash off and resolves ../ segments.
  const normalized = path.posix.normalize(posix);
  return normalized.replace(/^\.\//, '');
}

export function resolveIacImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // Resolution is cheap (a handful of IaC files); full pass is fine.
  void _scope;
  const { store } = state;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  // Pull `imports` edges tagged with an IaC dialect. The YAML plugin points
  // these at a per-ref placeholder constant symbol (kustomizeRef / build) whose
  // fqn encodes the path — a distinct target per ref so they don't collapse
  // under INSERT OR IGNORE. We rewrite each to the actual manifest / Dockerfile
  // node and drop the intermediate placeholder edge.
  const rows = store.db
    .prepare(
      `SELECT e.id AS edge_id, e.source_node_id AS src, e.metadata AS metadata, n.ref_id AS src_ref
         FROM edges e
         JOIN nodes n ON n.id = e.source_node_id AND n.node_type = 'symbol'
        WHERE e.edge_type_id = ?
          AND e.metadata IS NOT NULL`,
    )
    .all(importsEdgeType.id) as Array<{
    edge_id: number;
    src: number;
    src_ref: number;
    metadata: string;
  }>;

  const pending: SelfLoopImport[] = [];
  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      continue;
    }
    const dialect = typeof meta.dialect === 'string' ? meta.dialect : '';
    const module = typeof meta.module === 'string' ? meta.module : '';
    if (!IAC_DIALECTS.has(dialect) || !module) continue;
    pending.push({
      edgeId: row.edge_id,
      sourceNodeId: row.src,
      sourceRefId: row.src_ref,
      module,
      dialect,
      metadata: meta,
    });
  }

  if (pending.length === 0) return;

  // Build a set of indexed file paths (forward-slash) for existence checks,
  // plus a per-directory list to find a Dockerfile / kustomization.yaml.
  const allFiles = store.getAllFiles();
  const filePathSet = new Set<string>();
  const filesByDir = new Map<string, string[]>();
  for (const f of allFiles) {
    const p = f.path.split(path.sep).join('/');
    filePathSet.add(p);
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    let list = filesByDir.get(dir);
    if (!list) {
      list = [];
      filesByDir.set(dir, list);
    }
    list.push(p);
  }

  const KUSTOMIZATION_NAMES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];

  /** Resolve the source symbol's containing file path (repo-relative). */
  const sourceFilePath = (refId: number): string | undefined => {
    const sym = store.getSymbolById(refId);
    if (!sym || sym.file_id == null) return undefined;
    const f = store.getFileById(sym.file_id);
    return f ? f.path.split(path.sep).join('/') : undefined;
  };

  /**
   * Resolve a path ref (relative to `baseDir`) to a target file path in the
   * index. Handles direct file hits and directory refs (→ kustomization.yaml or
   * a Dockerfile inside that dir). Returns the repo-relative target file path.
   */
  const resolveTargetFile = (baseDir: string, ref: string, dialect: string): string | undefined => {
    // Terraform: only LOCAL module sources (./ or ../) point at in-repo files.
    // Registry (`terraform-aws-modules/vpc/aws`), git (`git::`), and other
    // remote sources cannot be resolved to a node — leave them dangling.
    if (dialect === 'terraform' && !ref.startsWith('./') && !ref.startsWith('../')) {
      return undefined;
    }

    const joined = baseDir ? `${baseDir}/${ref}` : ref;
    let candidate = normalizeRel(joined);
    // A bare `.` (compose `build: .` at repo root) normalises to `.` — the
    // root-dir bucket key is the empty string, so map it there.
    if (candidate === '.') candidate = '';
    // Escapes the project root — outside scope for this first cut.
    if (candidate.startsWith('..')) return undefined;

    // Direct file hit (e.g. resources: [deployment.yaml], build: Dockerfile.prod)
    if (candidate && filePathSet.has(candidate)) return candidate;

    // Directory ref — look inside for the conventional entry file.
    const dirFiles = filesByDir.get(candidate);
    if (dirFiles) {
      if (dialect === 'kustomize') {
        for (const name of KUSTOMIZATION_NAMES) {
          const p = candidate ? `${candidate}/${name}` : name;
          if (filePathSet.has(p)) return p;
        }
      } else if (dialect === 'terraform') {
        // Terraform module dir — prefer main.tf, else any .tf file in the dir.
        const mainTf = candidate ? `${candidate}/main.tf` : 'main.tf';
        if (filePathSet.has(mainTf)) return mainTf;
        const anyTf = dirFiles.find((p) => p.endsWith('.tf'));
        if (anyTf) return anyTf;
      } else {
        // docker-compose build context — the Dockerfile in that dir.
        const dockerfile = dirFiles.find((p) => {
          const base = p.slice(p.lastIndexOf('/') + 1);
          return base === 'Dockerfile' || base.startsWith('Dockerfile.');
        });
        if (dockerfile) return dockerfile;
      }
    }
    return undefined;
  };

  /**
   * Pick the best graph node for a resolved target file: a single K8s Resource
   * symbol node when the file has exactly one, else the file node itself.
   */
  const targetNodeFor = (targetPath: string): number | undefined => {
    const f = store.getFile(targetPath);
    if (!f) return undefined;
    const syms = store.getSymbolsByFile(f.id);
    const resources = syms.filter((s) => {
      if (!s.metadata) return false;
      try {
        const m = JSON.parse(s.metadata) as Record<string, unknown>;
        return m.yamlKind === 'k8sResource';
      } catch {
        return false;
      }
    });
    if (resources.length === 1) {
      const nodeId = store.getNodeId('symbol', resources[0].id);
      if (nodeId != null) return nodeId;
    }
    return store.getNodeId('file', f.id);
  };

  let resolved = 0;
  let dropped = 0;

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, ?, 0, 'ast_inferred')
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata, resolved = 1`,
  );
  const deleteStmt = store.db.prepare('DELETE FROM edges WHERE id = ?');

  const tx = store.db.transaction(() => {
    for (const p of pending) {
      const srcFile = sourceFilePath(p.sourceRefId);
      if (!srcFile) {
        continue;
      }
      const baseDir = srcFile.includes('/') ? srcFile.slice(0, srcFile.lastIndexOf('/')) : '';
      const targetPath = resolveTargetFile(baseDir, p.module, p.dialect);
      if (!targetPath) {
        // Dangling ref — drop the useless self-loop rather than leave a
        // source→source edge polluting the graph.
        deleteStmt.run(p.edgeId);
        dropped++;
        continue;
      }
      const targetNodeId = targetNodeFor(targetPath);
      if (targetNodeId == null || targetNodeId === p.sourceNodeId) {
        deleteStmt.run(p.edgeId);
        dropped++;
        continue;
      }
      // Rewrite: remove the self-loop, insert the resolved cross-file edge.
      deleteStmt.run(p.edgeId);
      insertStmt.run(
        p.sourceNodeId,
        targetNodeId,
        importsEdgeType.id,
        JSON.stringify({ ...p.metadata, resolvedTarget: targetPath }),
      );
      resolved++;
    }
  });
  tx();

  if (resolved > 0 || dropped > 0) {
    logger.info({ resolved, dropped }, 'IaC import edges resolved');
  }
}
