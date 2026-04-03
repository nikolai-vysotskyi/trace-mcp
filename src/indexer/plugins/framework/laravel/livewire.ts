/**
 * Livewire component extraction — supports v2 and v3.
 *
 * Extracts:
 * - Component class → Blade view (explicit render() or convention)
 * - Event dispatch/listen graph (v2: emit/$listeners, v3: dispatch/#[On])
 * - Form objects (v3 only)
 * - Public properties (reactive state) and methods (callable actions)
 * - Blade-side: <livewire:name/>, @livewire(), wire:click directives
 */
import type { RawEdge } from '../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface LivewireComponentInfo {
  className: string;
  namespace: string;
  fqn: string;
  /** Explicit view name from render() method, e.g. 'livewire.counter' */
  viewName: string | null;
  /** Convention-based view path (always computed) */
  conventionViewPath: string;
  properties: LivewireProperty[];
  actions: string[];
  dispatches: LivewireEventRef[];
  listeners: LivewireListenerRef[];
  formProperty: LivewireFormRef | null;
  version: 2 | 3;
}

export interface LivewireProperty {
  name: string;
  type: string | null;
  hasUrlAttribute: boolean;
  hasValidateAttribute: boolean;
  hasLockedAttribute: boolean;
  hasComputedAttribute: boolean;
}

export interface LivewireEventRef {
  eventName: string;
  method: string; // which method dispatches it
}

export interface LivewireListenerRef {
  eventName: string;
  handlerMethod: string;
}

export interface LivewireFormRef {
  propertyName: string;
  formClass: string;
}

export interface LivewireBladeUsage {
  componentName: string; // kebab-case: 'order-form'
  line: number;
  syntax: 'tag' | 'directive'; // <livewire:x/> vs @livewire('x')
}

export interface LivewireWireDirective {
  directive: string; // 'click', 'submit', 'model'
  value: string;     // method name or property name
  line: number;
}

// ─── PHP-side extraction ─────────────────────────────────────

const USE_STMT_RE = /use\s+([\w\\]+?)(?:\s+as\s+(\w+))?;/g;
const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_DECL_RE = /class\s+(\w+)\s+extends\s+([\w\\]+)/;

/** Check if class extends Livewire\Component (v3) or Livewire\Component (v2). */
const LIVEWIRE_EXTENDS_RE = /class\s+(\w+)\s+extends\s+(?:[\w\\]*\\)?Component\b/;

/** v3: #[On('event-name')] */
const ON_ATTRIBUTE_RE = /#\[On\(\s*['"]([\w.:*-]+)['"]\s*\)\]/g;

/** v3: $this->dispatch('event-name') */
const DISPATCH_RE = /\$this->dispatch\(\s*['"]([\w.:*-]+)['"]/g;

/** v2: $this->emit('eventName') / $this->emitTo('component', 'event') / $this->emitUp('event') */
const EMIT_RE = /\$this->emit(?:To|Up|Self)?\(\s*(?:['"][\w.-]+['"]\s*,\s*)?['"]([\w.-]+)['"]/g;

/** v2: protected $listeners = ['eventName' => 'handlerMethod', ...] */
const LISTENERS_PROP_RE = /protected\s+\$listeners\s*=\s*\[([\s\S]*?)\]\s*;/;

/** render() method returning view('livewire.xxx') */
const RENDER_VIEW_RE = /function\s+render\s*\([\s\S]*?\)\s*(?::\s*[\w\\|]+\s*)?\{[\s\S]*?view\(\s*['"]([\w.-]+)['"]\s*\)/;

/** Public method detection (callable actions) — excludes lifecycle hooks */
const PUBLIC_METHOD_RE = /public\s+function\s+(\w+)\s*\(/g;
const LIFECYCLE_METHODS = new Set([
  'mount', 'hydrate', 'dehydrate', 'render', 'updating', 'updated',
  'boot', 'booted', '__construct',
  // v2 computed getter pattern
]);

/** Public property detection */
const PUBLIC_PROP_RE = /(?:#\[([\w,\s()'":]+)\]\s*)*public\s+(?:(?:readonly\s+)?(\?\s*)?(\w[\w\\|]*)\s+)?\$(\w+)/g;

/** v3 #[Computed] attribute */
const COMPUTED_ATTR_RE = /#\[Computed(?:\(.*?\))?\]/;
/** v3 #[Url] attribute */
const URL_ATTR_RE = /#\[Url(?:\(.*?\))?\]/;
/** v3 #[Validate(...)] attribute */
const VALIDATE_ATTR_RE = /#\[Validate\(/;
/** v3 #[Locked] attribute */
const LOCKED_ATTR_RE = /#\[Locked(?:\(.*?\))?\]/;

/** v3: Form class typed property — public PostForm $form */
const FORM_EXTENDS_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?Form\b/;

/**
 * Extract Livewire component metadata from a PHP source file.
 * Returns null if the file does not contain a Livewire component.
 */
export function extractLivewireComponent(
  source: string,
  filePath: string,
): LivewireComponentInfo | null {
  if (!LIVEWIRE_EXTENDS_RE.test(source)) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_DECL_RE);
  if (!classMatch) return null;

  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // Detect version by namespace or API usage
  const version = detectVersion(source, namespace);

  // View resolution
  const viewMatch = source.match(RENDER_VIEW_RE);
  const viewName = viewMatch?.[1] ?? null;
  const conventionViewPath = classToConventionView(fqn, version);

  // Properties
  const properties = extractProperties(source);

  // Actions (public methods minus lifecycle)
  const actions = extractActions(source);

  // Events
  const dispatches = extractDispatches(source, version);
  const listeners = extractListeners(source, version);

  // Form (v3)
  const formProperty = extractFormProperty(source, useMap);

  return {
    className,
    namespace,
    fqn,
    viewName,
    conventionViewPath,
    properties,
    actions,
    dispatches,
    listeners,
    formProperty,
    version,
  };
}

/**
 * Detect if a PHP source is a Livewire Form class (v3).
 */
export function isLivewireForm(source: string): boolean {
  return FORM_EXTENDS_RE.test(source);
}

/**
 * Extract Livewire component usages from a Blade template.
 * Detects <livewire:name /> and @livewire('name') syntax.
 */
export function extractLivewireBladeUsages(source: string): LivewireBladeUsage[] {
  const usages: LivewireBladeUsage[] = [];

  // <livewire:component-name /> or <livewire:component-name>
  const tagRe = /<livewire:([\w.-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source)) !== null) {
    usages.push({
      componentName: match[1],
      line: lineAt(source, match.index),
      syntax: 'tag',
    });
  }

  // @livewire('component-name')
  const directiveRe = /@livewire\(\s*['"]([\w.-]+)['"]/g;
  while ((match = directiveRe.exec(source)) !== null) {
    usages.push({
      componentName: match[1],
      line: lineAt(source, match.index),
      syntax: 'directive',
    });
  }

  return usages;
}

/**
 * Extract wire: directives from a Blade template.
 * Returns wire:click, wire:submit actions (not wire:model — those are informational).
 */
export function extractWireDirectives(source: string): LivewireWireDirective[] {
  const directives: LivewireWireDirective[] = [];

  // wire:click="methodName" or wire:click.prevent="methodName"
  // wire:submit="methodName" or wire:submit.prevent="methodName"
  const wireRe = /wire:(click|submit)(?:\.\w+)*\s*=\s*['"]([\w.()$]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = wireRe.exec(source)) !== null) {
    let value = match[2];
    // Strip parentheses: "submit()" -> "submit"
    value = value.replace(/\(.*\)$/, '');
    directives.push({
      directive: match[1],
      value,
      line: lineAt(source, match.index),
    });
  }

  // wire:model is informational — include it for completeness
  const modelRe = /wire:model(?:\.\w+)*\s*=\s*['"]([\w.]+)['"]/g;
  while ((match = modelRe.exec(source)) !== null) {
    directives.push({
      directive: 'model',
      value: match[1],
      line: lineAt(source, match.index),
    });
  }

  return directives;
}

/**
 * Build edges from Livewire component info.
 * Creates livewire_renders, livewire_dispatches, livewire_listens edges.
 */
export function buildLivewireEdges(
  component: LivewireComponentInfo,
): RawEdge[] {
  const edges: RawEdge[] = [];

  // Component → View (livewire_renders)
  const viewPath = component.viewName
    ? `resources/views/${component.viewName.replace(/\./g, '/')}.blade.php`
    : component.conventionViewPath;

  edges.push({
    edgeType: 'livewire_renders',
    metadata: {
      sourceFqn: component.fqn,
      targetViewPath: viewPath,
      viewName: component.viewName,
      convention: !component.viewName,
    },
  });

  // Dispatches
  for (const dispatch of component.dispatches) {
    edges.push({
      edgeType: 'livewire_dispatches',
      metadata: {
        sourceFqn: component.fqn,
        eventName: dispatch.eventName,
        method: dispatch.method,
      },
    });
  }

  // Listeners
  for (const listener of component.listeners) {
    edges.push({
      edgeType: 'livewire_listens',
      metadata: {
        sourceFqn: component.fqn,
        eventName: listener.eventName,
        handlerMethod: listener.handlerMethod,
      },
    });
  }

  // Form (v3)
  if (component.formProperty) {
    edges.push({
      edgeType: 'livewire_form',
      metadata: {
        sourceFqn: component.fqn,
        targetFqn: component.formProperty.formClass,
        propertyName: component.formProperty.propertyName,
      },
    });
  }

  // Model references from typed properties
  for (const prop of component.properties) {
    if (prop.type && isEloquentLikeType(prop.type)) {
      edges.push({
        edgeType: 'livewire_uses_model',
        metadata: {
          sourceFqn: component.fqn,
          targetFqn: prop.type,
          propertyName: prop.name,
        },
      });
    }
  }

  return edges;
}

/**
 * Resolve a kebab-case component name to a class FQN.
 * 'order-form' → 'App\Livewire\OrderForm' (v3) or 'App\Http\Livewire\OrderForm' (v2)
 */
export function resolveComponentName(
  name: string,
  version: 2 | 3,
): string {
  // kebab-case → PascalCase: 'order-form' → 'OrderForm'
  const pascal = name
    .split(/[.-]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  return version === 3
    ? `App\\Livewire\\${pascal}`
    : `App\\Http\\Livewire\\${pascal}`;
}

// ─── Internal helpers ────────────────────────────────────────

function buildUseMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const regex = new RegExp(USE_STMT_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const fqn = match[1];
    const alias = match[2] ?? fqn.split('\\').pop()!;
    map.set(alias, fqn);
  }
  return map;
}

function resolveClass(ref: string, useMap: Map<string, string>): string {
  if (ref.includes('\\')) return ref;
  return useMap.get(ref) ?? ref;
}

function detectVersion(source: string, namespace: string): 2 | 3 {
  // v3 namespace pattern
  if (namespace.startsWith('App\\Livewire')) return 3;
  // v2 namespace pattern
  if (namespace.startsWith('App\\Http\\Livewire')) return 2;
  // v3 attributes
  if (/#\[On\(/.test(source) || /#\[Computed\]/.test(source) || /#\[Url\]/.test(source)) return 3;
  // v3 dispatch
  if (/\$this->dispatch\(/.test(source)) return 3;
  // v2 emit
  if (/\$this->emit\(/.test(source)) return 2;
  // v2 $listeners
  if (/protected\s+\$listeners/.test(source)) return 2;
  // Default to v3 (more recent)
  return 3;
}

function classToConventionView(fqn: string, version: 2 | 3): string {
  // Strip base namespace: App\Livewire\OrderForm → OrderForm
  // App\Http\Livewire\OrderForm → OrderForm
  // App\Livewire\Admin\UserList → Admin\UserList
  const prefix = version === 3 ? 'App\\Livewire\\' : 'App\\Http\\Livewire\\';
  let relative = fqn.startsWith(prefix) ? fqn.slice(prefix.length) : fqn;

  // PascalCase → kebab-case: 'OrderForm' → 'order-form'
  // 'Admin\UserList' → 'admin/user-list'
  relative = relative
    .replace(/\\/g, '/')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();

  return `resources/views/livewire/${relative}.blade.php`;
}

function extractProperties(source: string): LivewireProperty[] {
  const properties: LivewireProperty[] = [];
  const regex = new RegExp(PUBLIC_PROP_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const attrs = match[1] ?? '';
    const type = match[3] ?? null;
    const name = match[4];

    // Skip properties that look like framework internals
    if (name.startsWith('_')) continue;

    properties.push({
      name,
      type,
      hasUrlAttribute: URL_ATTR_RE.test(attrs),
      hasValidateAttribute: VALIDATE_ATTR_RE.test(attrs),
      hasLockedAttribute: LOCKED_ATTR_RE.test(attrs),
      hasComputedAttribute: COMPUTED_ATTR_RE.test(attrs),
    });
  }

  return properties;
}

function extractActions(source: string): string[] {
  const actions: string[] = [];
  const regex = new RegExp(PUBLIC_METHOD_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    if (!LIFECYCLE_METHODS.has(name) && !name.startsWith('get') && !name.endsWith('Property')) {
      actions.push(name);
    }
  }

  return actions;
}

function extractDispatches(source: string, version: 2 | 3): LivewireEventRef[] {
  const dispatches: LivewireEventRef[] = [];
  const re = version === 3 ? DISPATCH_RE : EMIT_RE;
  const regex = new RegExp(re.source, 'g');
  let match: RegExpExecArray | null;

  // Find which method each dispatch is in
  const methods = extractMethodBodies(source);

  while ((match = regex.exec(source)) !== null) {
    const eventName = match[1];
    const pos = match.index;
    const method = findEnclosingMethod(methods, pos) ?? 'unknown';
    dispatches.push({ eventName, method });
  }

  return dispatches;
}

function extractListeners(source: string, version: 2 | 3): LivewireListenerRef[] {
  const listeners: LivewireListenerRef[] = [];

  if (version === 3) {
    // #[On('event-name')] on methods
    const onRe = new RegExp(ON_ATTRIBUTE_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = onRe.exec(source)) !== null) {
      const eventName = match[1];
      // Next public function after this attribute
      const after = source.slice(match.index);
      const methodMatch = after.match(/function\s+(\w+)\s*\(/);
      if (methodMatch) {
        listeners.push({ eventName, handlerMethod: methodMatch[1] });
      }
    }
  } else {
    // v2: protected $listeners = ['eventName' => 'handlerMethod', 'eventName']
    const listenersMatch = source.match(LISTENERS_PROP_RE);
    if (listenersMatch) {
      const body = listenersMatch[1];
      // 'eventName' => 'handlerMethod'
      const pairRe = /['"]([\w.-]+)['"]\s*=>\s*['"]([\w]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = pairRe.exec(body)) !== null) {
        listeners.push({ eventName: match[1], handlerMethod: match[2] });
      }
      // 'eventName' (shorthand — handler = same name)
      const shortRe = /(?<!=\s*)\s*['"]([\w.-]+)['"]\s*(?=[,\]])/g;
      while ((match = shortRe.exec(body)) !== null) {
        // Avoid re-matching the key part of key => value pairs
        if (!body.slice(Math.max(0, match.index - 5), match.index).includes('=>')) {
          // Check if this is not the value side of a => pair
          const before = body.slice(0, match.index);
          if (!before.trimEnd().endsWith('=>')) {
            listeners.push({ eventName: match[1], handlerMethod: match[1] });
          }
        }
      }
    }
  }

  return listeners;
}

function extractFormProperty(
  source: string,
  useMap: Map<string, string>,
): LivewireFormRef | null {
  // Look for typed public property whose type extends Form
  // Pattern: public SomeForm $form (or $propertyName)
  const formPropRe = /public\s+(\w+)\s+\$(\w+)/g;
  let match: RegExpExecArray | null;

  while ((match = formPropRe.exec(source)) !== null) {
    const typeName = match[1];
    const propName = match[2];
    const resolvedType = resolveClass(typeName, useMap);

    // Heuristic: type name ends with Form, or known to extend Livewire\Form
    if (typeName.endsWith('Form') || resolvedType.endsWith('Form')) {
      return { propertyName: propName, formClass: resolvedType };
    }
  }

  return null;
}

interface MethodRange {
  name: string;
  start: number;
  end: number;
}

function extractMethodBodies(source: string): MethodRange[] {
  const methods: MethodRange[] = [];
  const methodStartRe = /(?:public|protected|private)\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  let match: RegExpExecArray | null;

  while ((match = methodStartRe.exec(source)) !== null) {
    const name = match[1];
    const start = match.index;
    const braceStart = source.indexOf('{', start + match[0].length - 1);
    const end = findMatchingBrace(source, braceStart);
    methods.push({ name, start, end });
  }

  return methods;
}

function findMatchingBrace(source: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

function findEnclosingMethod(methods: MethodRange[], pos: number): string | null {
  for (const m of methods) {
    if (pos >= m.start && pos <= m.end) return m.name;
  }
  return null;
}

function lineAt(source: string, offset: number): number {
  return source.substring(0, offset).split('\n').length;
}

function isEloquentLikeType(type: string): boolean {
  // Common model namespace patterns
  return /\\Models\\/.test(type) || /^App\\Models\\/.test(type);
}
