import { logger } from '../../logger.js';
import type { PipelineState } from '../pipeline-state.js';

/**
 * Resolve Python import edges from pendingImports into file��file edges.
 * Similar to resolveEsmImportEdges but for Python's module system.
 */
export function resolvePythonImportEdges(state: PipelineState): void {
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  // Collect all indexed Python files for resolution
  const allPyFiles = store.db
    .prepare(`SELECT id, path FROM files WHERE language = 'python'`)
    .all() as Array<{ id: number; path: string }>;

  if (allPyFiles.length === 0) return;

  // Build module → fileId lookup:
  // myapp/models.py → "myapp.models"
  // myapp/__init__.py → "myapp"
  // myapp/utils/helpers.py → "myapp.utils.helpers"
  const moduleToFile = new Map<string, { id: number; path: string }>();
  for (const f of allPyFiles) {
    const modulePath = filePathToModule(f.path);
    if (modulePath) {
      moduleToFile.set(modulePath, f);
    }
  }

  // Pre-load file node IDs
  const fileNodeMap = new Map<number, number>();
  const fileIds = allPyFiles.map((f) => f.id);
  const CHUNK = 500;
  for (let i = 0; i < fileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', fileIds.slice(i, i + CHUNK))) {
      fileNodeMap.set(k, v);
    }
  }

  const importsEdgeType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  // Collect all pending file IDs and their paths
  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);

  // Pre-load node IDs for pending files
  for (let i = 0; i < pendingFileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', pendingFileIds.slice(i, i + CHUNK))) {
      fileNodeMap.set(k, v);
    }
  }

  let created = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file || file.language !== 'python') continue;

      const sourceNodeId = fileNodeMap.get(fileId);
      if (sourceNodeId == null) continue;

      // Consolidate imports by `from` path
      const consolidated = new Map<string, string[]>();
      for (const { from, specifiers } of imports) {
        const existing = consolidated.get(from);
        if (existing) existing.push(...specifiers);
        else consolidated.set(from, [...specifiers]);
      }

      for (const [fromPath, specifiers] of consolidated) {
        const resolved = resolvePythonModule(fromPath, file.path, moduleToFile);
        if (!resolved) continue;

        const targetNodeId = fileNodeMap.get(resolved.id);
        if (targetNodeId == null) continue;
        if (sourceNodeId === targetNodeId) continue;

        insertStmt.run(
          sourceNodeId,
          targetNodeId,
          importsEdgeType.id,
          JSON.stringify({ from: fromPath, specifiers }),
        );
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'Python import edges resolved');
  }
}

/**
 * Convert a file path to a Python module dotted path.
 * - `myapp/models.py` → `myapp.models`
 * - `myapp/__init__.py` → `myapp`
 * - `src/myapp/utils.py` → `src.myapp.utils`
 */
function filePathToModule(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.endsWith('.py') && !normalized.endsWith('.pyi')) return null;

  let module = normalized.replace(/\.pyi?$/, '');
  // __init__ → use parent package
  if (module.endsWith('/__init__')) {
    module = module.slice(0, -'/__init__'.length);
  }
  return module.replace(/\//g, '.');
}

/**
 * Resolve a Python import `from` path to a file.
 *
 * Examples:
 * - `from myapp.models import User` (from="myapp.models") → myapp/models.py
 * - `from . import utils` (from=".utils", relative to myapp/views.py) → myapp/utils.py
 * - `from ..core import base` (from="..core", relative to myapp/sub/views.py) → myapp/core.py
 * - `import os.path` (from="os.path") → not resolvable (stdlib)
 */
function resolvePythonModule(
  fromPath: string,
  sourceFilePath: string,
  moduleIndex: Map<string, { id: number; path: string }>,
): { id: number; path: string } | null {
  if (!fromPath) return null;

  // Handle relative imports
  if (fromPath.startsWith('.')) {
    return resolveRelativeImport(fromPath, sourceFilePath, moduleIndex);
  }

  // Absolute import — try exact module match first
  const exact = moduleIndex.get(fromPath);
  if (exact) return exact;

  // Try as package: `import myapp` → `myapp/__init__.py`
  // Already handled by moduleIndex since __init__.py maps to "myapp"

  // Try parent module (e.g. `from myapp.models import User` where
  // the actual file is `myapp/models/user.py` — try `myapp.models`)
  // Already covered by exact match above.

  // Try stripping last component and checking if it's a submodule
  // `from myapp.models.user import User` → try `myapp.models.user`
  // Already covered.

  return null;
}

/**
 * Resolve a relative import path.
 * `.utils` from `myapp/views.py` → `myapp.utils`
 * `..core` from `myapp/sub/views.py` → `myapp.core`
 * `.` from `myapp/sub/__init__.py` → `myapp.sub`
 */
function resolveRelativeImport(
  fromPath: string,
  sourceFilePath: string,
  moduleIndex: Map<string, { id: number; path: string }>,
): { id: number; path: string } | null {
  // Count dots
  let dotCount = 0;
  while (dotCount < fromPath.length && fromPath[dotCount] === '.') dotCount++;
  const remainder = fromPath.slice(dotCount);

  // Get the source module's package path
  const normalized = sourceFilePath.replace(/\\/g, '/');
  const parts = normalized.replace(/\.pyi?$/, '').split('/');

  // If source is __init__.py, the package IS the directory
  const isInit = normalized.endsWith('__init__.py') || normalized.endsWith('__init__.pyi');
  if (isInit) {
    // __init__.py: current package = directory itself
    // `.` means this package, `..` means parent
    parts.pop(); // remove __init__
  } else {
    // Regular file: current package = parent directory
    // `.` means sibling, `..` means parent package
    parts.pop(); // remove filename
  }

  // Go up (dotCount - 1) levels (1 dot = current package)
  for (let i = 0; i < dotCount - 1; i++) {
    if (parts.length === 0) return null; // too many dots
    parts.pop();
  }

  // Build target module path
  const basePath = parts.join('.');
  const targetModule = remainder ? (basePath ? `${basePath}.${remainder}` : remainder) : basePath;

  if (!targetModule) return null;

  const resolved = moduleIndex.get(targetModule);
  if (resolved) return resolved;

  return null;
}
