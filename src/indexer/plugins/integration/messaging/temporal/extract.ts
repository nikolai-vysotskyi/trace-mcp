/**
 * Per-language regex extraction for Temporal workflow/activity/signal/query/update code.
 *
 * Temporal's four SDKs mark workflows/activities very differently:
 *
 *   Python (temporalio):    @workflow.defn class + @workflow.run/@workflow.signal/
 *                            @workflow.query/@workflow.update methods; @activity.defn functions.
 *   TypeScript (@temporalio/*): no decorators — workflows are exported functions in
 *                            files importing '@temporalio/workflow'; activities are
 *                            plain exported functions referenced via proxyActivities().
 *                            Signals/queries/updates are `defineSignal`/`defineQuery`/
 *                            `defineUpdate` consts registered via `setHandler(...)`.
 *   Java (io.temporal):      @WorkflowInterface + @WorkflowMethod/@SignalMethod/
 *                            @QueryMethod/@UpdateMethod on an interface; @ActivityInterface
 *                            + @ActivityMethod on another.
 *   Go (go.temporal.io/sdk): no annotations at all — functions are identified only
 *                            by being passed to worker.RegisterWorkflow/RegisterActivity.
 *                            Signals/queries are channel/string-name based
 *                            (workflow.GetSignalChannel/SetQueryHandler), not symbol-based.
 *                            This is the most heuristic of the four.
 */

export type TemporalRole = 'workflow' | 'activity' | 'signal' | 'query' | 'update';

export interface TemporalSymbolRef {
  name: string;
  role: TemporalRole;
  line: number;
}

export function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

// ─── Python (temporalio) ───────────────────────────────────────────────────

const PY_WORKFLOW_DEFN_CLASS_RE = /@workflow\.defn(?:\([^)]*\))?\s*\n\s*class\s+(\w+)/g;
const PY_WORKFLOW_RUN_METHOD_RE = /@workflow\.run\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
const PY_WORKFLOW_SIGNAL_METHOD_RE =
  /@workflow\.signal(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
const PY_WORKFLOW_QUERY_METHOD_RE =
  /@workflow\.query(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
const PY_WORKFLOW_UPDATE_METHOD_RE =
  /@workflow\.update(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
const PY_ACTIVITY_DEFN_RE = /@activity\.defn(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
export const PY_EXECUTE_ACTIVITY_RE =
  /\bworkflow\.execute_activity(?:_method)?\s*\(\s*["']?([\w.]+)/g;
/** `handle.signal(MyWorkflow.my_signal, ...)` or `handle.signal("signal_name", ...)`. */
export const PY_SEND_SIGNAL_RE = /\.signal\s*\(\s*["']?([\w.]+)/g;
export const PY_EXECUTE_CHILD_WORKFLOW_RE =
  /\bworkflow\.(?:execute|start)_child_workflow\s*\(\s*["']?([\w.]+)/g;
export const PY_SEND_UPDATE_RE = /\.(?:execute|start)_update\s*\(\s*["']?([\w.]+)/g;

/**
 * Module-level `NAME = "value"` (or `NAME: str = "value"`) constant assignment, unindented.
 * Also matches the parenthesized multi-line form black/ruff produce for long values:
 * `NAME = (\n    "value"\n)` — the optional `\(?` plus `\s*` (which spans newlines) before
 * the quote absorbs that wrapping.
 * Temporal dispatch call sites (`execute_activity`, `execute_child_workflow`, `.signal(...)`,
 * `.execute_update(...)`) very commonly pass one of these constants instead of a direct
 * function/class reference — the constant's *name* differs from the target it names, but its
 * assigned *value* is conventionally equal to the target symbol's own name.
 */
const PY_CONSTANT_ASSIGN_RE = /^([A-Z][A-Z0-9_]*)\s*(?::\s*\w+)?\s*=\s*\(?\s*["']([^"']+)["']/gm;

/** Maps each module-level UPPER_CASE string constant in `source` to its literal value. */
export function extractPythonConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const re = new RegExp(PY_CONSTANT_ASSIGN_RE.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    constants.set(m[1], m[2]);
  }
  return constants;
}

export function extractTemporalPython(source: string): TemporalSymbolRef[] {
  const refs: TemporalSymbolRef[] = [];
  for (const re of [PY_WORKFLOW_DEFN_CLASS_RE, PY_WORKFLOW_RUN_METHOD_RE]) {
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(source)) !== null) {
      refs.push({ name: m[1], role: 'workflow', line: lineOf(source, m.index) });
    }
  }
  for (const [re, role] of [
    [PY_WORKFLOW_SIGNAL_METHOD_RE, 'signal'],
    [PY_WORKFLOW_QUERY_METHOD_RE, 'query'],
    [PY_WORKFLOW_UPDATE_METHOD_RE, 'update'],
  ] as const) {
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(source)) !== null) {
      refs.push({ name: m[1], role, line: lineOf(source, m.index) });
    }
  }
  const activityRe = new RegExp(PY_ACTIVITY_DEFN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = activityRe.exec(source)) !== null) {
    refs.push({ name: m[1], role: 'activity', line: lineOf(source, m.index) });
  }
  return refs;
}

// ─── TypeScript (@temporalio/*) ────────────────────────────────────────────

const TS_WORKFLOW_IMPORT_RE = /from\s+['"]@temporalio\/workflow['"]/;
const TS_EXPORTED_FUNCTION_RE = /export\s+(?:async\s+)?function\s+(\w+)/g;
const TS_EXPORTED_CONST_FN_RE = /export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/g;
/** `const cancelSignal = defineSignal<[]>('cancel')` / `defineQuery` / `defineUpdate`. */
const TS_DEFINE_SIGNAL_QUERY_UPDATE_RE =
  /\bconst\s+(\w+)\s*=\s*define(Signal|Query|Update)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** `setHandler(cancelSignal, handlerFn)` — registers the handler for a defined signal/query/update. */
export const TS_SET_HANDLER_RE = /\bsetHandler\s*\(\s*(\w+)\s*,/g;
/** `import { foo, bar as baz } from './module'` (relative imports only — that's all we can resolve). */
const TS_NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{\s*([^}]+?)\s*\}\s*from\s+['"](\.[^'"]+)['"]/g;
/** `handle.signal(cancelSignal, ...)` — send site for a signal defined via `defineSignal`. */
export const TS_SEND_SIGNAL_RE = /\.signal\s*\(\s*(\w+)/g;
/** `handle.executeUpdate(myUpdate, ...)` / `handle.startUpdate(myUpdate, ...)`. */
export const TS_SEND_UPDATE_RE = /\.(?:executeUpdate|startUpdate)\s*\(\s*(\w+)/g;
/** `executeChild(childWorkflowFn, ...)` / `startChild(childWorkflowFn, ...)`. */
export const TS_EXECUTE_CHILD_RE = /\b(?:executeChild|startChild)\s*\(\s*(\w+)/g;

// `proxyActivities<...>(...)` is bound one of two ways in real Temporal TS code:
//   const activities = proxyActivities<typeof activities>(...)       — namespace form,
//                                                                       calls as activities.foo()
//   const { greet } = proxyActivities<typeof activities>(...)        — destructured form,
//                                                                       calls as greet()
// Each also has an inline `typeof import('./x')` variant and a
// `import [type] * as X from './x'` + `typeof X` alias variant.
const TS_PROXY_NAMESPACE_INLINE_RE =
  /const\s+(\w+)\s*=\s*proxyActivities<\s*typeof\s+import\(\s*['"]([^'"]+)['"]\s*\)\s*>\s*\(/g;
const TS_PROXY_NAMESPACE_ALIAS_RE =
  /const\s+(\w+)\s*=\s*proxyActivities<\s*typeof\s+(\w+)\s*>\s*\(/g;
const TS_PROXY_DESTRUCTURED_INLINE_RE =
  /const\s*\{\s*([^}]+?)\s*\}\s*=\s*proxyActivities<\s*typeof\s+import\(\s*['"]([^'"]+)['"]\s*\)\s*>\s*\(/g;
const TS_PROXY_DESTRUCTURED_ALIAS_RE =
  /const\s*\{\s*([^}]+?)\s*\}\s*=\s*proxyActivities<\s*typeof\s+(\w+)\s*>\s*\(/g;
/** `import [type] * as X from '...'` — resolves a namespace alias to its module specifier. */
const TS_NAMESPACE_IMPORT_RE = /import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

export interface DestructuredActivityBinding {
  /** The exported name on the activities module, e.g. `greet` in `{ greet as sayHello }`. */
  exportName: string;
  /** The local name calls actually use, e.g. `sayHello` in `{ greet as sayHello }`. */
  localName: string;
}

export interface TsActivitiesProxy {
  /** Raw import specifier for the activities module, e.g. `'./activities'`. */
  modulePath: string;
  /** Set for `const activities = proxyActivities(...)` — calls look like `activities.foo()`. */
  binding?: string;
  /** Set for `const { greet } = proxyActivities(...)` — calls look like `greet()` directly. */
  names?: DestructuredActivityBinding[];
}

export interface TsNamedImport {
  /** The exported identifier on the source module, e.g. `cancelSignal` in `{ cancelSignal as cancel }`. */
  exportName: string;
  /** The local identifier calls actually use, e.g. `cancel` in `{ cancelSignal as cancel }`. */
  localName: string;
  /** Raw (relative) import specifier, e.g. `'./workflows'`. */
  modulePath: string;
}

export interface TsDefineBinding {
  /** The identifier the defined signal/query/update is bound to locally, e.g. `cancelSignal`. */
  localName: string;
  /** The string name Temporal uses on the wire, e.g. `'cancel'`. */
  definedName: string;
  kind: 'signal' | 'query' | 'update';
}

function parseDestructuredNames(raw: string): DestructuredActivityBinding[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(part);
      return asMatch
        ? { exportName: asMatch[1], localName: asMatch[2] }
        : { exportName: part, localName: part };
    });
}

/**
 * Finds every `proxyActivities<...>()` call in a workflow file and resolves
 * it to the activities module specifier plus how it's bound locally —
 * either a namespace object (`activities.foo()`) or destructured names
 * (`foo()` directly) — so callers can find the right call-site pattern.
 */
export function findTsActivitiesProxies(source: string): TsActivitiesProxy[] {
  const proxies: TsActivitiesProxy[] = [];

  const nsInlineRe = new RegExp(TS_PROXY_NAMESPACE_INLINE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = nsInlineRe.exec(source)) !== null) {
    proxies.push({ binding: m[1], modulePath: m[2] });
  }

  const destructuredInlineRe = new RegExp(TS_PROXY_DESTRUCTURED_INLINE_RE.source, 'g');
  while ((m = destructuredInlineRe.exec(source)) !== null) {
    proxies.push({ names: parseDestructuredNames(m[1]), modulePath: m[2] });
  }

  const namespaceImports = new Map<string, string>();
  const nsImportRe = new RegExp(TS_NAMESPACE_IMPORT_RE.source, 'g');
  while ((m = nsImportRe.exec(source)) !== null) {
    namespaceImports.set(m[1], m[2]);
  }

  const nsAliasRe = new RegExp(TS_PROXY_NAMESPACE_ALIAS_RE.source, 'g');
  while ((m = nsAliasRe.exec(source)) !== null) {
    const modulePath = namespaceImports.get(m[2]);
    if (modulePath) proxies.push({ binding: m[1], modulePath });
  }

  const destructuredAliasRe = new RegExp(TS_PROXY_DESTRUCTURED_ALIAS_RE.source, 'g');
  while ((m = destructuredAliasRe.exec(source)) !== null) {
    const modulePath = namespaceImports.get(m[2]);
    if (modulePath) proxies.push({ names: parseDestructuredNames(m[1]), modulePath });
  }

  return proxies;
}

/** Resolves `import { foo, bar as baz } from './module'` to (localName, exportName, modulePath) triples. */
export function findTsNamedImports(source: string): TsNamedImport[] {
  const imports: TsNamedImport[] = [];
  const re = new RegExp(TS_NAMED_IMPORT_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const modulePath = m[2];
    for (const { exportName, localName } of parseDestructuredNames(m[1])) {
      imports.push({ exportName, localName, modulePath });
    }
  }
  return imports;
}

/** Maps each `defineSignal`/`defineQuery`/`defineUpdate` local const to its kind + wire name. */
export function findTsDefineBindings(source: string): Map<string, TsDefineBinding> {
  const bindings = new Map<string, TsDefineBinding>();
  const re = new RegExp(TS_DEFINE_SIGNAL_QUERY_UPDATE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kind = m[2].toLowerCase() as TsDefineBinding['kind'];
    bindings.set(m[1], { localName: m[1], definedName: m[3], kind });
  }
  return bindings;
}

/** True if `name` is invoked (`name(`) anywhere in `source` outside of the line it's declared on. */
function isCalledInternally(source: string, name: string, declarationLine: number): boolean {
  const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    if (lineOf(source, m.index) !== declarationLine) return true;
  }
  return false;
}

function extractTsSignalQueryUpdateHandlers(source: string): TemporalSymbolRef[] {
  const refs: TemporalSymbolRef[] = [];
  const bindings = findTsDefineBindings(source);
  const handlerRe = new RegExp(TS_SET_HANDLER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = handlerRe.exec(source)) !== null) {
    const binding = bindings.get(m[1]);
    if (!binding) continue;
    refs.push({ name: binding.definedName, role: binding.kind, line: lineOf(source, m.index) });
  }
  return refs;
}

export function extractTemporalTypeScript(source: string): TemporalSymbolRef[] {
  const refs: TemporalSymbolRef[] = [];
  if (!TS_WORKFLOW_IMPORT_RE.test(source)) return refs;

  // Workflow entry points are only ever invoked by the Temporal runtime, never called
  // directly within their own file — unlike a helper the workflow calls internally.
  // Use that to filter out exported-but-internal helpers.
  const fnRe = new RegExp(TS_EXPORTED_FUNCTION_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(source)) !== null) {
    const line = lineOf(source, m.index);
    if (!isCalledInternally(source, m[1], line)) {
      refs.push({ name: m[1], role: 'workflow', line });
    }
  }
  const constRe = new RegExp(TS_EXPORTED_CONST_FN_RE.source, 'g');
  while ((m = constRe.exec(source)) !== null) {
    const line = lineOf(source, m.index);
    if (!isCalledInternally(source, m[1], line)) {
      refs.push({ name: m[1], role: 'workflow', line });
    }
  }

  refs.push(...extractTsSignalQueryUpdateHandlers(source));

  return refs;
}

// ─── Java (io.temporal) ────────────────────────────────────────────────────

const JAVA_WORKFLOW_INTERFACE_RE =
  /@WorkflowInterface\s*\n\s*(?:public\s+)?interface\s+(\w+)\s*\{([^}]*)\}/g;
const JAVA_ACTIVITY_INTERFACE_RE =
  /@ActivityInterface\s*\n\s*(?:public\s+)?interface\s+(\w+)\s*\{([^}]*)\}/g;
const JAVA_INTERFACE_METHOD_RE = /(\w+)\s*\([^;]*\)\s*;/g;
export const JAVA_NEW_ACTIVITY_STUB_RE =
  /(\w+)\s+(\w+)\s*=\s*Workflow\.newActivityStub\(\s*(\w+)\.class/g;
/** `Workflow.newChildWorkflowStub(ChildWorkflow.class)` — links a call to a child workflow. */
export const JAVA_NEW_CHILD_WORKFLOW_STUB_RE =
  /(\w+)\s+(\w+)\s*=\s*Workflow\.newChildWorkflowStub\(\s*(\w+)\.class/g;
/** `WorkflowClient.newWorkflowStub(MyWorkflow.class, ...)` — signals/updates an unrelated running workflow. */
export const JAVA_NEW_EXTERNAL_WORKFLOW_STUB_RE =
  /(\w+)\s+(\w+)\s*=\s*WorkflowClient\.newWorkflowStub\(\s*(\w+)\.class/g;

export interface JavaInterfaceExtraction {
  refs: TemporalSymbolRef[];
  /** interfaceName -> methodName -> role (signal/query/update methods are tagged individually). */
  interfaceMethods: Map<string, Map<string, TemporalRole>>;
}

/** Looks for @SignalMethod/@QueryMethod/@UpdateMethod immediately preceding a method declaration. */
function roleForJavaWorkflowMethod(
  body: string,
  precedingStart: number,
  methodStart: number,
): TemporalRole {
  const preceding = body.slice(precedingStart, methodStart);
  if (/@SignalMethod\b/.test(preceding)) return 'signal';
  if (/@QueryMethod\b/.test(preceding)) return 'query';
  if (/@UpdateMethod\b/.test(preceding)) return 'update';
  return 'workflow';
}

export function extractTemporalJava(source: string): JavaInterfaceExtraction {
  const refs: TemporalSymbolRef[] = [];
  const interfaceMethods = new Map<string, Map<string, TemporalRole>>();

  for (const [re, defaultRole] of [
    [JAVA_WORKFLOW_INTERFACE_RE, 'workflow'],
    [JAVA_ACTIVITY_INTERFACE_RE, 'activity'],
  ] as const) {
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(source)) !== null) {
      const [, interfaceName, body] = m;
      refs.push({ name: interfaceName, role: defaultRole, line: lineOf(source, m.index) });

      const methods = new Map<string, TemporalRole>();
      const methodRe = new RegExp(JAVA_INTERFACE_METHOD_RE.source, 'g');
      let mm: RegExpExecArray | null;
      let precedingEnd = 0;
      while ((mm = methodRe.exec(body)) !== null) {
        const methodName = mm[1];
        const role: TemporalRole =
          defaultRole === 'workflow'
            ? roleForJavaWorkflowMethod(body, precedingEnd, mm.index)
            : defaultRole;
        methods.set(methodName, role);
        refs.push({ name: methodName, role, line: lineOf(source, m.index) });
        precedingEnd = methodRe.lastIndex;
      }
      interfaceMethods.set(interfaceName, methods);
    }
  }

  return { refs, interfaceMethods };
}

// ─── Go (go.temporal.io/sdk) ───────────────────────────────────────────────

// Accepts both the bare-function form (`w.RegisterActivity(ComposeGreeting)`) and the
// struct-method DI form (`w.RegisterActivity(a.ComposeGreeting)`) — the latter is resolved
// to its last dotted segment (`ComposeGreeting`), same as Python's `Type.method` resolution.
const GO_REGISTER_WORKFLOW_RE = /\bRegisterWorkflow(?:WithOptions)?\s*\(\s*(\w+(?:\.\w+)?)/g;
const GO_REGISTER_ACTIVITY_RE = /\bRegisterActivity(?:WithOptions)?\s*\(\s*(\w+(?:\.\w+)?)/g;
export const GO_EXECUTE_ACTIVITY_RE =
  /\bworkflow\.ExecuteActivity\s*\(\s*ctx\s*,\s*(?:"([\w.]+)"|(\w+(?:\.\w+)?))/g;
export const GO_EXECUTE_CHILD_WORKFLOW_RE =
  /\bworkflow\.ExecuteChildWorkflow\s*\(\s*ctx\s*,\s*(?:"([\w.]+)"|(\w+(?:\.\w+)?))/g;
/** Go signals/queries are channel/string-name based, not symbol-based. */
export const GO_SIGNAL_CHANNEL_RE = /\bworkflow\.GetSignalChannel\s*\(\s*ctx\s*,\s*"([^"]+)"/g;
export const GO_QUERY_HANDLER_RE = /\bworkflow\.SetQueryHandler\s*\(\s*ctx\s*,\s*"([^"]+)"/g;
export const GO_SIGNAL_EXTERNAL_RE =
  /\b(?:workflow\.SignalExternalWorkflow|client\.SignalWorkflow)\s*\([^)]*?,\s*"([^"]+)"/g;

/** Resolves a Go activity/workflow reference (bare identifier or `recv.Method`) to its function name. */
export function resolveGoIdentifier(raw: string): string {
  return raw.includes('.') ? raw.split('.').pop()! : raw;
}

export function extractTemporalGo(source: string): TemporalSymbolRef[] {
  const refs: TemporalSymbolRef[] = [];
  for (const [re, role] of [
    [GO_REGISTER_WORKFLOW_RE, 'workflow'],
    [GO_REGISTER_ACTIVITY_RE, 'activity'],
  ] as const) {
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(source)) !== null) {
      refs.push({ name: resolveGoIdentifier(m[1]), role, line: lineOf(source, m.index) });
    }
  }

  const signalRe = new RegExp(GO_SIGNAL_CHANNEL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = signalRe.exec(source)) !== null) {
    refs.push({ name: m[1], role: 'signal', line: lineOf(source, m.index) });
  }
  const queryRe = new RegExp(GO_QUERY_HANDLER_RE.source, 'g');
  while ((m = queryRe.exec(source)) !== null) {
    refs.push({ name: m[1], role: 'query', line: lineOf(source, m.index) });
  }

  return refs;
}
