/**
 * SortablePlugin — detects drag-and-drop sortable libraries and extracts
 * event handlers, group config, and shared-group cross-list connections.
 *
 * Covered packages:
 *   - sortablejs            (vanilla JS API: `new Sortable(el, { onEnd, group, handle })`)
 *   - sortablejs-vue3       (Vue 3 wrapper: `<Sortable :options @end @update />`)
 *   - vue-draggable-next    (Vue 3 wrapper: `<draggable v-model :group @end @update />`)
 *   - vuedraggable          (Vue 2 equivalent — same template syntax)
 *
 * Pass 1 (extractNodes):
 *   - sortable_event:  enclosing component → event handler name
 *   - sortable_group:  component → group::<name> (named group registration)
 *
 * Pass 2 (resolveEdges):
 *   - sortable_shared_group: cross-component link between sortables sharing
 *     a named group (the only case where group name is functionally meaningful).
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

const SORTABLE_PACKAGES = [
  'sortablejs',
  'sortablejs-vue3',
  'vue-draggable-next',
  'vuedraggable',
];

const SORTABLE_EVENTS = [
  'onChoose', 'onUnchoose', 'onStart', 'onEnd',
  'onAdd', 'onUpdate', 'onSort', 'onRemove',
  'onFilter', 'onMove', 'onClone', 'onChange',
  'onSelect', 'onDeselect',
] as const;

const VUE_DRAGGABLE_TAGS = /<\s*(draggable|Sortable|VueDraggable|VueDraggableNext)\b/i;

const NEW_SORTABLE_RE =
  /new\s+Sortable\s*\(\s*[^,]+,\s*\{([\s\S]*?)\}\s*\)/g;

const SORTABLE_CREATE_RE =
  /Sortable\s*\.\s*create\s*\(\s*[^,]+,\s*\{([\s\S]*?)\}\s*\)/g;

const SORTABLE_IMPORT_RE =
  /(?:import|require)\s*(?:\(|\{)?\s*[^'"]*['"](?:sortablejs|sortablejs-vue3|vue-draggable-next|vuedraggable)['"]/;

const VUE_EVENT_RE = /@([a-z][a-z0-9-]*)\s*=\s*["']([^"']+)["']/gi;

// Static attribute: <draggable group="kanban">
const VUE_STATIC_GROUP_RE = /\sgroup\s*=\s*"([^"{}]+)"/g;

// Dynamic attribute with quoted literal: :group="'kanban'" or :group="`kanban`"
const VUE_DYN_LITERAL_GROUP_RE = /:group\s*=\s*"\s*['"`]([^'"`]+)['"`]\s*"/g;

// Dynamic attribute with inline object: :group="{ name: 'kanban', pull: true }"
const VUE_DYN_OBJECT_GROUP_RE =
  /:group\s*=\s*"[^"]*?\{[^}]*\bname\s*:\s*['"`]([^'"`]+)['"`][^}]*\}[^"]*"/g;

const HANDLER_OPTION_RE = /\b(on[A-Z][a-zA-Z]+)\s*:\s*([A-Za-z_$][\w$]*)/g;
const GROUP_OPTION_STRING_RE = /\bgroup\s*:\s*['"]([^'"]+)['"]/;
const GROUP_OPTION_OBJECT_RE = /\bgroup\s*:\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/;
const HANDLE_OPTION_RE = /\bhandle\s*:\s*['"]([^'"]+)['"]/;

interface ParsedOptions {
  handlers: Array<{ event: string; handler: string }>;
  group: string | null;
  handle: string | null;
}

function extractVueGroup(source: string): string | null {
  // Order matters: object form is most specific, then dynamic literal, then static.
  for (const re of [VUE_DYN_OBJECT_GROUP_RE, VUE_DYN_LITERAL_GROUP_RE, VUE_STATIC_GROUP_RE]) {
    re.lastIndex = 0;
    const m = re.exec(source);
    if (m) return m[1];
  }
  // Fallback: an `:options="{ group: ... }"` wrapper exposes the JS option syntax.
  const objMatch = source.match(GROUP_OPTION_OBJECT_RE);
  if (objMatch) return objMatch[1];
  const strMatch = source.match(GROUP_OPTION_STRING_RE);
  if (strMatch) return strMatch[1];
  return null;
}

function parseOptionsBlock(block: string): ParsedOptions {
  const handlers: Array<{ event: string; handler: string }> = [];
  HANDLER_OPTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HANDLER_OPTION_RE.exec(block)) !== null) {
    if ((SORTABLE_EVENTS as readonly string[]).includes(m[1])) {
      handlers.push({ event: m[1], handler: m[2] });
    }
  }
  const groupObj = block.match(GROUP_OPTION_OBJECT_RE);
  const groupStr = block.match(GROUP_OPTION_STRING_RE);
  const handle = block.match(HANDLE_OPTION_RE);
  return {
    handlers,
    group: groupObj?.[1] ?? groupStr?.[1] ?? null,
    handle: handle?.[1] ?? null,
  };
}

export class SortablePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'sortable',
    version: '1.0.0',
    priority: 45,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of SORTABLE_PACKAGES) {
        if (pkg in deps) return true;
      }
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const p of SORTABLE_PACKAGES) {
        if (p in deps) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'sortable_event', category: 'sortable', description: 'Sortable component → drag event handler' },
        { name: 'sortable_group', category: 'sortable', description: 'Sortable component declares named group' },
        { name: 'sortable_shared_group', category: 'sortable', description: 'Two sortables share a named group (cross-list dnd)' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript', 'vue'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const hasImport = SORTABLE_IMPORT_RE.test(source);
    const hasDraggableTag = language === 'vue' && VUE_DRAGGABLE_TAGS.test(source);

    if (!hasImport && !hasDraggableTag) {
      return ok({ status: 'ok', symbols: [] });
    }

    let groupName: string | null = null;
    let totalHandlers = 0;

    // ── JS/TS: `new Sortable(el, {...})` and `Sortable.create(el, {...})` ──
    for (const re of [NEW_SORTABLE_RE, SORTABLE_CREATE_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const opts = parseOptionsBlock(m[1]);
        for (const h of opts.handlers) {
          result.edges!.push({
            edgeType: 'sortable_event',
            metadata: { event: h.event, handler: h.handler, file: filePath },
          });
          totalHandlers++;
        }
        if (opts.group) groupName = opts.group;
      }
    }

    // ── Vue templates: <draggable @end="fn" :group="'name'" /> ──
    if (language === 'vue' && hasDraggableTag) {
      VUE_EVENT_RE.lastIndex = 0;
      let em: RegExpExecArray | null;
      while ((em = VUE_EVENT_RE.exec(source)) !== null) {
        const evtRaw = em[1].toLowerCase();
        const evt = `on${evtRaw.charAt(0).toUpperCase()}${evtRaw.slice(1)}`;
        if (!(SORTABLE_EVENTS as readonly string[]).includes(evt)) continue;
        result.edges!.push({
          edgeType: 'sortable_event',
          metadata: { event: evt, handler: em[2], file: filePath },
        });
        totalHandlers++;
      }
      groupName = extractVueGroup(source) ?? groupName;
    }

    if (groupName) {
      result.edges!.push({
        edgeType: 'sortable_group',
        metadata: { group: groupName, file: filePath },
        targetSymbolId: `sortable-group::${groupName}`,
      });
    }

    if (totalHandlers > 0 || groupName) {
      result.frameworkRole = 'sortable_consumer';
    } else if (hasImport || hasDraggableTag) {
      result.frameworkRole = 'sortable_usage';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const groupParticipants = new Map<string, string[]>();

    for (const file of ctx.getAllFiles()) {
      if (!file.language) continue;
      if (!['typescript', 'javascript', 'vue'].includes(file.language)) continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      if (!SORTABLE_IMPORT_RE.test(source) && !VUE_DRAGGABLE_TAGS.test(source)) continue;

      const groups = new Set<string>();
      const groupObj = source.match(GROUP_OPTION_OBJECT_RE);
      if (groupObj) groups.add(groupObj[1]);
      const groupStr = source.match(GROUP_OPTION_STRING_RE);
      if (groupStr) groups.add(groupStr[1]);
      if (file.language === 'vue') {
        const vg = extractVueGroup(source);
        if (vg) groups.add(vg);
      }

      for (const g of groups) {
        const list = groupParticipants.get(g) ?? [];
        list.push(file.path);
        groupParticipants.set(g, list);
      }
    }

    for (const [group, files] of groupParticipants) {
      if (files.length < 2) continue;
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          edges.push({
            edgeType: 'sortable_shared_group',
            sourceSymbolId: `sortable-group::${group}`,
            targetSymbolId: `sortable-group::${group}`,
            metadata: { group, fileA: files[i], fileB: files[j] },
            resolution: 'text_matched',
          });
        }
      }
    }

    return ok(edges);
  }
}
