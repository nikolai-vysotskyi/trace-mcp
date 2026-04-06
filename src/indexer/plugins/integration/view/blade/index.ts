/**
 * BladePlugin — detects Blade template directives and creates edges
 * for @extends, @include, @component, and <x-component> usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

interface BladeDirective {
  type: 'extends' | 'include' | 'component' | 'x-component';
  name: string;
  line: number;
}

/** Detect @extends('layout.name') */
const EXTENDS_RE = /@extends\(\s*['"]([\w.-]+)['"]\s*\)/g;

/** Detect @include('partial.name') and @includeIf, @includeWhen etc. */
const INCLUDE_RE = /@include(?:If|When|Unless|First)?\(\s*['"]([\w.-]+)['"]/g;

/** Detect @component('component.name') */
const COMPONENT_RE = /@component\(\s*['"]([\w.-]+)['"]/g;

/** Detect <x-component-name> (Blade anonymous/class components) */
const X_COMPONENT_RE = /<x-([\w.-]+)/g;

/** Detect @section('name') */
const SECTION_RE = /@section\(\s*['"]([\w.-]+)['"]/g;

/** Detect @yield('name') */
const YIELD_RE = /@yield\(\s*['"]([\w.-]+)['"]/g;

export function extractBladeDirectives(source: string): BladeDirective[] {
  const directives: BladeDirective[] = [];

  const extract = (re: RegExp, type: BladeDirective['type']) => {
    let match: RegExpExecArray | null;
    const regex = new RegExp(re.source, 'g');
    while ((match = regex.exec(source)) !== null) {
      const before = source.substring(0, match.index);
      const line = before.split('\n').length;
      directives.push({ type, name: match[1], line });
    }
  };

  extract(EXTENDS_RE, 'extends');
  extract(INCLUDE_RE, 'include');
  extract(COMPONENT_RE, 'component');
  extract(X_COMPONENT_RE, 'x-component');

  return directives;
}

export function extractBladeSections(source: string): string[] {
  const sections: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(SECTION_RE.source, 'g');
  while ((match = re.exec(source)) !== null) {
    sections.push(match[1]);
  }
  return sections;
}

export function extractBladeYields(source: string): string[] {
  const yields: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(YIELD_RE.source, 'g');
  while ((match = re.exec(source)) !== null) {
    yields.push(match[1]);
  }
  return yields;
}

/**
 * Convert a Blade dot-notation view name to a file path.
 * 'layouts.app' -> 'resources/views/layouts/app.blade.php'
 */
export function bladeNameToPath(name: string): string {
  return `resources/views/${name.replace(/\./g, '/')}.blade.php`;
}

/**
 * Convert an x-component name to possible file paths.
 * 'user-card' -> 'resources/views/components/user-card.blade.php'
 */
export function xComponentToPath(name: string): string {
  return `resources/views/components/${name}.blade.php`;
}

export class BladePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'blade',
    version: '1.0.0',
    priority: 5,
    category: 'view',
    dependencies: ['laravel'],
  };

  detect(ctx: ProjectContext): boolean {
    // Check if resources/views/ exists with .blade.php files
    try {
      const viewsDir = path.join(ctx.rootPath, 'resources', 'views');
      const stat = fs.statSync(viewsDir);
      if (!stat.isDirectory()) return false;
      // Quick check: any .blade.php in the directory tree
      return this.hasBlade(viewsDir);
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'blade_extends', category: 'blade', description: '@extends directive' },
        { name: 'blade_includes', category: 'blade', description: '@include directive' },
        { name: 'blade_component', category: 'blade', description: '<x-component> or @component' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    _language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!filePath.endsWith('.blade.php')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const sections = extractBladeSections(source);
    const yields = extractBladeYields(source);

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      frameworkRole: yields.length > 0 ? 'blade_layout' : 'blade_view',
    };

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // Build file path -> file map
    const fileMap = new Map<string, { id: number; path: string }>();
    for (const f of allFiles) {
      fileMap.set(f.path, f);
    }

    for (const file of allFiles) {
      if (!file.path.endsWith('.blade.php')) continue;

      const source = ctx.readFile(file.path);
      if (!source) continue;

      const directives = extractBladeDirectives(source);
      if (directives.length === 0) continue;

      const sourceNodeId = ctx.createNodeIfNeeded('file', file.id);

      for (const dir of directives) {
        let targetPath: string;
        let edgeType: string;

        switch (dir.type) {
          case 'extends':
            targetPath = bladeNameToPath(dir.name);
            edgeType = 'blade_extends';
            break;
          case 'include':
            targetPath = bladeNameToPath(dir.name);
            edgeType = 'blade_includes';
            break;
          case 'component':
            targetPath = bladeNameToPath(dir.name);
            edgeType = 'blade_component';
            break;
          case 'x-component':
            targetPath = xComponentToPath(dir.name);
            edgeType = 'blade_component';
            break;
        }

        const targetFile = fileMap.get(targetPath);
        if (!targetFile) continue;

        const targetNodeId = ctx.createNodeIfNeeded('file', targetFile.id);

        edges.push({
          sourceNodeType: 'file',
          sourceRefId: file.id,
          targetNodeType: 'file',
          targetRefId: targetFile.id,
          edgeType,
          metadata: { directive: dir.type, name: dir.name, line: dir.line },
        });
      }
    }

    return ok(edges);
  }

  private hasBlade(dir: string): boolean {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.blade.php')) return true;
        if (entry.isDirectory()) {
          if (this.hasBlade(path.join(dir, entry.name))) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }
}
