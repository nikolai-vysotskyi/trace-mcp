/**
 * get_module_graph — NestJS module dependency graph.
 *
 * Traces: module -> imports -> controllers -> providers -> exports.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';
import { extractModuleInfo } from '../indexer/plugins/integration/framework/nestjs/index.js';

interface ModuleGraphNode {
  name: string;
  file?: string;
  imports: string[];
  controllers: string[];
  providers: string[];
  exports: string[];
}

interface ModuleGraphResult {
  rootModule: string;
  modules: ModuleGraphNode[];
}

/**
 * Build module dependency graph starting from a named NestJS module.
 */
export function getModuleGraph(
  store: Store,
  rootPath: string,
  moduleName: string,
): TraceMcpResult<ModuleGraphResult> {
  const allFiles = store.getAllFiles();
  const moduleFiles = allFiles.filter((f) => f.framework_role === 'nest_module');

  if (moduleFiles.length === 0) {
    return err(notFound(moduleName, ['No NestJS modules found. Run reindex first.']));
  }

  // Build map of module name -> info
  const moduleMap = new Map<string, ModuleGraphNode>();

  for (const file of moduleFiles) {
    let source: string;
    try {
      source = fs.readFileSync(path.resolve(rootPath, file.path), 'utf-8');
    } catch { continue; }

    const info = extractModuleInfo(source);
    if (!info) continue;

    // Extract class name from file
    const classMatch = source.match(/export\s+class\s+(\w+)/);
    const name = classMatch?.[1] ?? path.basename(file.path, path.extname(file.path));

    moduleMap.set(name, {
      name,
      file: file.path,
      imports: info.imports,
      controllers: info.controllers,
      providers: info.providers,
      exports: info.exports,
    });
  }

  // Find root module
  const rootModule = moduleMap.get(moduleName);
  if (!rootModule) {
    const available = [...moduleMap.keys()];
    return err(notFound(moduleName, available.length > 0
      ? [`Available modules: ${available.join(', ')}`]
      : ['No NestJS modules found']));
  }

  // BFS to collect reachable modules
  const visited = new Set<string>();
  const queue = [moduleName];
  const result: ModuleGraphNode[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const mod = moduleMap.get(current);
    if (!mod) continue;

    result.push(mod);

    for (const imp of mod.imports) {
      if (!visited.has(imp)) {
        queue.push(imp);
      }
    }
  }

  return ok({ rootModule: moduleName, modules: result });
}
