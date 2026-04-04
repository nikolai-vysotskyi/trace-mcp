/**
 * CeleryPlugin — Celery task queue plugin.
 *
 * Detects 'celery' in Python dependencies and extracts:
 * - @app.task / @celery.task / @shared_task decorated functions (celery_task_registered)
 * - beat_schedule configuration entries (celery_beat_schedule)
 * - .delay() and .apply_async() calls on known tasks (celery_dispatches)
 *
 * Uses tree-sitter-python for AST-based extraction.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { ok, err } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
  EdgeTypeDeclaration,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';
import { parseError } from '../../../../../errors.js';
import { escapeRegExp } from '../../../../../utils/security.js';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const PythonGrammar = require('tree-sitter-python');

// tree-sitter types (CJS interop)
type TSNode = {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  childCount: number;
  namedChildren: TSNode[];
  namedChild(index: number): TSNode | null;
  child(index: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  parent: TSNode | null;
  isNamed: boolean;
  hasError: boolean;
};

let parserInstance: InstanceType<typeof Parser> | null = null;

function getParser(): InstanceType<typeof Parser> {
  if (!parserInstance) {
    parserInstance = new Parser();
    parserInstance!.setLanguage(PythonGrammar);
  }
  return parserInstance!;
}

// ============================================================
// Python dependency detection
// ============================================================

function hasPythonDep(rootPath: string, depName: string): boolean {
  for (const reqFile of ['requirements.txt', 'requirements/base.txt', 'requirements/prod.txt']) {
    try {
      const content = fs.readFileSync(path.join(rootPath, reqFile), 'utf-8');
      if (new RegExp(`^${escapeRegExp(depName)}\\b`, 'm').test(content)) return true;
    } catch { /* not found */ }
  }

  try {
    const content = fs.readFileSync(path.join(rootPath, 'pyproject.toml'), 'utf-8');
    if (content.includes(depName)) return true;
  } catch { /* not found */ }

  for (const f of ['setup.py', 'setup.cfg']) {
    try {
      const content = fs.readFileSync(path.join(rootPath, f), 'utf-8');
      if (content.includes(depName)) return true;
    } catch { /* not found */ }
  }

  try {
    const content = fs.readFileSync(path.join(rootPath, 'Pipfile'), 'utf-8');
    if (content.includes(depName)) return true;
  } catch { /* not found */ }

  return false;
}

// ============================================================
// AST helpers
// ============================================================

function stripQuotes(s: string): string {
  return s.replace(/^[brufBRUF]*['"]/, '').replace(/['"]$/, '');
}

/** Walk all nodes of a given type. */
function walkNodes(node: TSNode, type: string, visitor: (n: TSNode) => void): void {
  if (node.type === type) {
    visitor(node);
  }
  for (const child of node.namedChildren) {
    walkNodes(child, type, visitor);
  }
}

/** Walk all nodes, calling visitor for each. */
function walkAll(node: TSNode, visitor: (n: TSNode) => void): void {
  visitor(node);
  for (const child of node.namedChildren) {
    walkAll(child, visitor);
  }
}

// ============================================================
// Celery task extraction
// ============================================================

interface CeleryTaskInfo {
  functionName: string;
  taskName: string | null; // explicit name from decorator arg
  line: number;
}

/**
 * Match decorator patterns:
 * - @app.task / @celery.task / @celery_app.task (attribute form)
 * - @app.task(name='...') / @celery.task(bind=True, name='...')
 * - @shared_task / @shared_task(name='...')
 */
function isCeleryTaskDecorator(decoratorNode: TSNode): { isTask: boolean; taskName: string | null } {
  // decorator node's child is the actual expression
  const expr = decoratorNode.namedChildren[0];
  if (!expr) return { isTask: false, taskName: null };

  // Simple identifier: @shared_task
  if (expr.type === 'identifier' && expr.text === 'shared_task') {
    return { isTask: true, taskName: null };
  }

  // Attribute: @app.task or @celery.task
  if (expr.type === 'attribute') {
    const attrName = expr.childForFieldName('attribute');
    if (attrName?.text === 'task') {
      return { isTask: true, taskName: null };
    }
  }

  // Call form: @shared_task(...) or @app.task(...)
  if (expr.type === 'call') {
    const fn = expr.childForFieldName('function');
    let isTask = false;

    if (fn?.type === 'identifier' && fn.text === 'shared_task') {
      isTask = true;
    } else if (fn?.type === 'attribute') {
      const attrName = fn.childForFieldName('attribute');
      if (attrName?.text === 'task') {
        isTask = true;
      }
    }

    if (isTask) {
      // Extract name= keyword argument
      const args = expr.childForFieldName('arguments');
      if (args) {
        for (const arg of args.namedChildren) {
          if (arg.type === 'keyword_argument') {
            const nameNode = arg.childForFieldName('name');
            const valueNode = arg.childForFieldName('value');
            if (nameNode?.text === 'name' && valueNode?.type === 'string') {
              return { isTask: true, taskName: stripQuotes(valueNode.text) };
            }
          }
        }
      }
      return { isTask: true, taskName: null };
    }
  }

  return { isTask: false, taskName: null };
}

function extractCeleryTasks(root: TSNode): CeleryTaskInfo[] {
  const tasks: CeleryTaskInfo[] = [];

  for (const child of root.namedChildren) {
    if (child.type !== 'decorated_definition') continue;

    // Find the function inside the decorated_definition
    const funcDef = child.namedChildren.find(c => c.type === 'function_definition');
    if (!funcDef) continue;

    const funcName = funcDef.childForFieldName('name')?.text;
    if (!funcName) continue;

    // Check each decorator
    const decorators = child.namedChildren.filter(c => c.type === 'decorator');
    for (const dec of decorators) {
      const { isTask, taskName } = isCeleryTaskDecorator(dec);
      if (isTask) {
        tasks.push({
          functionName: funcName,
          taskName,
          line: child.startPosition.row + 1,
        });
        break; // one match is enough
      }
    }
  }

  return tasks;
}

// ============================================================
// Beat schedule extraction
// ============================================================

interface BeatScheduleEntry {
  entryName: string;
  taskName: string;
  line: number;
}

/**
 * Extract beat_schedule entries from:
 *   app.conf.beat_schedule = { 'entry-name': { 'task': 'module.task_name', ... }, ... }
 *   CELERY_BEAT_SCHEDULE = { ... }  (Django settings style)
 *
 * Parses dictionary literal for task names.
 */
function extractBeatSchedule(root: TSNode): BeatScheduleEntry[] {
  const entries: BeatScheduleEntry[] = [];

  walkAll(root, (node) => {
    if (node.type !== 'assignment') return;

    const left = node.childForFieldName('left');
    if (!left) return;

    // Match app.conf.beat_schedule or CELERY_BEAT_SCHEDULE or beat_schedule
    const target = left.text;
    const isBeatSchedule =
      target.endsWith('beat_schedule') ||
      target === 'CELERY_BEAT_SCHEDULE';
    if (!isBeatSchedule) return;

    const right = node.childForFieldName('right');
    if (!right || right.type !== 'dictionary') return;

    // Each top-level pair is an entry: 'entry-name': { 'task': '...', ... }
    for (const pair of right.namedChildren) {
      if (pair.type !== 'pair') continue;

      const keyNode = pair.childForFieldName('key');
      const valueNode = pair.childForFieldName('value');
      if (!keyNode || !valueNode) continue;

      const entryName = keyNode.type === 'string' ? stripQuotes(keyNode.text) : keyNode.text;

      // The value should be a dict containing 'task': 'some.task.name'
      if (valueNode.type !== 'dictionary') continue;

      for (const innerPair of valueNode.namedChildren) {
        if (innerPair.type !== 'pair') continue;

        const innerKey = innerPair.childForFieldName('key');
        const innerValue = innerPair.childForFieldName('value');
        if (!innerKey || !innerValue) continue;

        const k = innerKey.type === 'string' ? stripQuotes(innerKey.text) : innerKey.text;
        if (k === 'task' && innerValue.type === 'string') {
          const taskName = stripQuotes(innerValue.text);
          entries.push({
            entryName,
            taskName,
            line: pair.startPosition.row + 1,
          });
        }
      }
    }
  });

  return entries;
}

// ============================================================
// Dispatch call extraction (.delay() / .apply_async())
// ============================================================

interface DispatchCall {
  calledOn: string; // the identifier being called on
  method: 'delay' | 'apply_async';
  line: number;
}

/**
 * Find .delay() and .apply_async() calls.
 * Best-effort: only captures calls where the object is a simple identifier
 * (e.g., send_email.delay(), process_order.apply_async()).
 */
function extractDispatchCalls(root: TSNode): DispatchCall[] {
  const dispatches: DispatchCall[] = [];

  walkAll(root, (node) => {
    if (node.type !== 'call') return;

    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') return;

    const attrName = fn.childForFieldName('attribute')?.text;
    if (attrName !== 'delay' && attrName !== 'apply_async') return;

    const obj = fn.childForFieldName('object');
    if (!obj) return;

    // Only capture simple identifiers or dotted names
    if (obj.type === 'identifier' || obj.type === 'attribute') {
      dispatches.push({
        calledOn: obj.text,
        method: attrName as 'delay' | 'apply_async',
        line: node.startPosition.row + 1,
      });
    }
  });

  return dispatches;
}

// ============================================================
// Plugin class
// ============================================================

export class CeleryPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'celery',
    version: '1.0.0',
    priority: 30,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx.rootPath, 'celery');
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'celery_task_registered', category: 'celery', description: '@app.task / @shared_task → function' } as EdgeTypeDeclaration,
        { name: 'celery_beat_schedule', category: 'celery', description: 'Beat schedule entry → task' } as EdgeTypeDeclaration,
        { name: 'celery_dispatches', category: 'celery', description: '.delay() / .apply_async() → task' } as EdgeTypeDeclaration,
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      routes: [],
    };

    let tree: { rootNode: TSNode };
    try {
      const parser = getParser();
      tree = parser.parse(source);
    } catch (e) {
      return err(parseError(filePath, `tree-sitter parse failed: ${e}`));
    }

    const root = tree.rootNode;

    // --- Celery tasks ---
    const tasks = extractCeleryTasks(root);
    const knownTaskFunctions = new Set<string>();

    for (const task of tasks) {
      const taskName = task.taskName ?? task.functionName;
      knownTaskFunctions.add(task.functionName);

      result.edges!.push({
        edgeType: 'celery_task_registered',
        sourceSymbolId: `${filePath}::${task.functionName}#function`,
        targetSymbolId: `${filePath}::${task.functionName}#function`,
        metadata: {
          taskName,
          explicitName: task.taskName ?? undefined,
          line: task.line,
        },
      });

      // Store as route-like entity for discoverability
      result.routes!.push({
        method: 'TASK',
        uri: taskName,
        name: task.functionName,
        line: task.line,
      });

      result.frameworkRole = 'celery_tasks';
    }

    // --- Beat schedule ---
    const beatEntries = extractBeatSchedule(root);
    for (const entry of beatEntries) {
      result.edges!.push({
        edgeType: 'celery_beat_schedule',
        sourceSymbolId: `${filePath}::beat_schedule_${entry.entryName}`,
        targetSymbolId: entry.taskName, // resolved in pass 2 by task name
        metadata: {
          entryName: entry.entryName,
          taskName: entry.taskName,
          line: entry.line,
        },
      });

      result.frameworkRole = result.frameworkRole ?? 'celery_beat';
    }

    // --- Dispatch calls (.delay / .apply_async) ---
    const dispatches = extractDispatchCalls(root);
    for (const dispatch of dispatches) {
      // Best-effort: only emit edge when the callee is a known task in the same file
      if (knownTaskFunctions.has(dispatch.calledOn)) {
        result.edges!.push({
          edgeType: 'celery_dispatches',
          sourceSymbolId: filePath, // file-level — caller context unknown without scope analysis
          targetSymbolId: `${filePath}::${dispatch.calledOn}#function`,
          metadata: {
            method: dispatch.method,
            line: dispatch.line,
          },
        });
      } else {
        // Cross-file dispatch — emit with unresolved target
        result.edges!.push({
          edgeType: 'celery_dispatches',
          sourceSymbolId: filePath,
          targetSymbolId: dispatch.calledOn, // resolved in pass 2
          metadata: {
            method: dispatch.method,
            line: dispatch.line,
            crossFile: true,
          },
        });
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
