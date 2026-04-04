/**
 * Multi-project router for the MCP server.
 * Resolves which project a file path belongs to (longest-prefix match)
 * and provides access to the correct Store/Pipeline/Config.
 */

import path from 'node:path';
import type { Store } from './db/store.js';
import type { IndexingPipeline } from './indexer/pipeline.js';
import type { PluginRegistry } from './plugin-api/registry.js';
import type { TraceMcpConfig } from './config.js';
import type { ProjectInstance } from './project-setup.js';

export interface ProjectContext {
  root: string;
  store: Store;
  pipeline: IndexingPipeline;
  registry: PluginRegistry;
  config: TraceMcpConfig;
}

export class ProjectRouter {
  /** Sorted by root path length descending for longest-prefix-first matching. */
  private entries: Array<{ root: string; instance: ProjectInstance }> = [];

  addProject(instance: ProjectInstance): void {
    this.entries.push({ root: instance.root, instance });
    // Re-sort: longest root first (most specific match wins)
    this.entries.sort((a, b) => b.root.length - a.root.length);
  }

  /** Resolve a file path to the project it belongs to. */
  resolveProject(filePath: string): ProjectContext | null {
    const abs = path.resolve(filePath);
    for (const entry of this.entries) {
      if (abs.startsWith(entry.root + path.sep) || abs === entry.root) {
        return {
          root: entry.instance.root,
          store: entry.instance.store,
          pipeline: entry.instance.pipeline,
          registry: entry.instance.registry,
          config: entry.instance.config,
        };
      }
    }
    return null;
  }

  /** Resolve a project by its root path (exact match). */
  getProjectByRoot(root: string): ProjectContext | null {
    const abs = path.resolve(root);
    const entry = this.entries.find((e) => e.root === abs);
    if (!entry) return null;
    return {
      root: entry.instance.root,
      store: entry.instance.store,
      pipeline: entry.instance.pipeline,
      registry: entry.instance.registry,
      config: entry.instance.config,
    };
  }

  /** Get all projects. */
  getAllProjects(): ProjectContext[] {
    return this.entries.map((e) => ({
      root: e.instance.root,
      store: e.instance.store,
      pipeline: e.instance.pipeline,
      registry: e.instance.registry,
      config: e.instance.config,
    }));
  }

  /** Get all project instances (for shutdown etc). */
  getAllInstances(): ProjectInstance[] {
    return this.entries.map((e) => e.instance);
  }

  /** Get a list of all registered project roots. */
  getRoots(): string[] {
    return this.entries.map((e) => e.root);
  }

  /** Number of projects. */
  get size(): number {
    return this.entries.length;
  }
}
