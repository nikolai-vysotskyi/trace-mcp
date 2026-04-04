/**
 * AngularPlugin — detects Angular projects and extracts components,
 * services, modules, directives, pipes, and dependency injection edges.
 *
 * Angular is a platform for building mobile and desktop web applications
 * using TypeScript/JavaScript.
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
  RawComponent,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// --- Regex patterns ---

// @Component({ selector: 'app-root', ... })
const COMPONENT_RE =
  /@Component\s*\(\s*\{[^}]*selector\s*:\s*['"]([^'"]+)['"]/gs;

// @Injectable()
const INJECTABLE_RE = /@Injectable\s*\(/g;

// @NgModule({ ... })
const NGMODULE_RE = /@NgModule\s*\(/g;

// @Directive({ selector: '[appHighlight]' })
const DIRECTIVE_RE =
  /@Directive\s*\(\s*\{[^}]*selector\s*:\s*['"]([^'"]+)['"]/gs;

// @Pipe({ name: 'myPipe' })
const PIPE_RE =
  /@Pipe\s*\(\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/gs;

// @Input('alias') propName  or  @Input() propName
const INPUT_RE =
  /@Input\s*\(\s*(?:['"]([^'"]*)['"]\s*)?\)\s*(\w+)/g;

// @Output('alias') eventName  or  @Output() eventName
const OUTPUT_RE =
  /@Output\s*\(\s*(?:['"]([^'"]*)['"]\s*)?\)\s*(\w+)/g;

// inject(ServiceName)
const INJECT_RE = /inject\s*\(\s*(\w+)\s*\)/g;

// Constructor injection: constructor(private someService: SomeService, ...)
const CTOR_INJECT_RE =
  /constructor\s*\(([^)]*)\)/g;

// NgModule declarations, imports, providers arrays
const NGMODULE_DECLARATIONS_RE =
  /@NgModule\s*\(\s*\{[^}]*declarations\s*:\s*\[([^\]]*)\]/gs;
const NGMODULE_IMPORTS_RE =
  /@NgModule\s*\(\s*\{[^}]*imports\s*:\s*\[([^\]]*)\]/gs;
const NGMODULE_PROVIDERS_RE =
  /@NgModule\s*\(\s*\{[^}]*providers\s*:\s*\[([^\]]*)\]/gs;

// Template component usage: <app-some-component or <SomeComponent
const TEMPLATE_RE =
  /template\s*:\s*`([^`]*)`/gs;
const TEMPLATE_TAG_RE =
  /<([a-z][\w-]*[a-z\d])/g;

/** Extract class name preceding a decorator. */
function extractClassName(source: string, decoratorIndex: number): string | null {
  const after = source.slice(decoratorIndex);
  const classMatch = /class\s+(\w+)/.exec(after);
  return classMatch ? classMatch[1] : null;
}

/** Parse constructor parameters to find injected services. */
function extractCtorInjections(ctorParams: string): string[] {
  const services: string[] = [];
  // Match patterns like: private authService: AuthService, protected http: HttpClient
  const paramRe = /(?:private|protected|public|readonly)\s+\w+\s*:\s*(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(ctorParams)) !== null) {
    services.push(m[1]);
  }
  return services;
}

/** Parse comma-separated identifiers from an array literal body. */
function parseArrayItems(arrayBody: string): string[] {
  return arrayBody
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\w+$/.test(s));
}

export class AngularPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'angular',
    version: '1.0.0',
    priority: 25,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('@angular/core' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return '@angular/core' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'angular_renders', category: 'angular', description: 'Component renders child component in template' },
        { name: 'angular_injects', category: 'angular', description: 'Component or service injects a dependency' },
        { name: 'angular_provides', category: 'angular', description: 'Module provides a service' },
        { name: 'angular_imports_module', category: 'angular', description: 'Module imports another module' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      components: [],
    };

    let match: RegExpExecArray | null;

    // --- Components ---
    const componentRe = new RegExp(COMPONENT_RE.source, 'gs');
    while ((match = componentRe.exec(source)) !== null) {
      const selector = match[1];
      const className = extractClassName(source, match.index);

      // Extract @Input and @Output for this component
      const props: Record<string, unknown> = {};
      const emits: string[] = [];

      const inputRe = new RegExp(INPUT_RE.source, 'g');
      let inputMatch: RegExpExecArray | null;
      while ((inputMatch = inputRe.exec(source)) !== null) {
        const alias = inputMatch[1] || inputMatch[2];
        props[alias] = { type: 'input' };
      }

      const outputRe = new RegExp(OUTPUT_RE.source, 'g');
      let outputMatch: RegExpExecArray | null;
      while ((outputMatch = outputRe.exec(source)) !== null) {
        const alias = outputMatch[1] || outputMatch[2];
        emits.push(alias);
      }

      result.components!.push({
        name: className ?? selector,
        kind: 'component',
        props: Object.keys(props).length > 0 ? props : undefined,
        emits: emits.length > 0 ? emits : undefined,
        framework: 'angular',
      });

      result.frameworkRole = 'angular_component';

      // Extract inject() calls
      const injectRe = new RegExp(INJECT_RE.source, 'g');
      let injectMatch: RegExpExecArray | null;
      while ((injectMatch = injectRe.exec(source)) !== null) {
        result.edges!.push({
          sourceSymbolId: `${filePath}::${className ?? selector}#class`,
          targetNodeType: 'angular_service',
          edgeType: 'angular_injects',
          metadata: { service: injectMatch[1] },
        });
      }

      // Extract constructor injections
      const ctorRe = new RegExp(CTOR_INJECT_RE.source, 'g');
      let ctorMatch: RegExpExecArray | null;
      while ((ctorMatch = ctorRe.exec(source)) !== null) {
        const injections = extractCtorInjections(ctorMatch[1]);
        for (const svc of injections) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${className ?? selector}#class`,
            targetNodeType: 'angular_service',
            edgeType: 'angular_injects',
            metadata: { service: svc },
          });
        }
      }

      // Extract template component usage for angular_renders edges
      const templateRe = new RegExp(TEMPLATE_RE.source, 'gs');
      let templateMatch: RegExpExecArray | null;
      while ((templateMatch = templateRe.exec(source)) !== null) {
        const templateBody = templateMatch[1];
        const tagRe = new RegExp(TEMPLATE_TAG_RE.source, 'g');
        let tagMatch: RegExpExecArray | null;
        while ((tagMatch = tagRe.exec(templateBody)) !== null) {
          const tag = tagMatch[1];
          // Skip standard HTML tags
          if (isHtmlTag(tag)) continue;
          result.edges!.push({
            sourceSymbolId: `${filePath}::${className ?? selector}#class`,
            targetNodeType: 'angular_component',
            edgeType: 'angular_renders',
            metadata: { tag },
          });
        }
      }
    }

    // --- Services (Injectable) ---
    const injectableRe = new RegExp(INJECTABLE_RE.source, 'g');
    while ((match = injectableRe.exec(source)) !== null) {
      const className = extractClassName(source, match.index);
      if (!className) continue;

      // Skip if this is already captured as a component (components also use @Injectable sometimes)
      const alreadyComponent = result.components!.some((c) => c.name === className);
      if (alreadyComponent) continue;

      result.components!.push({
        name: className,
        kind: 'provider',
        framework: 'angular',
      });

      result.frameworkRole = result.frameworkRole ?? 'angular_service';

      // Extract inject() calls within this service
      const injectRe = new RegExp(INJECT_RE.source, 'g');
      let injectMatch: RegExpExecArray | null;
      while ((injectMatch = injectRe.exec(source)) !== null) {
        result.edges!.push({
          sourceSymbolId: `${filePath}::${className}#class`,
          targetNodeType: 'angular_service',
          edgeType: 'angular_injects',
          metadata: { service: injectMatch[1] },
        });
      }

      // Constructor injections
      const ctorRe = new RegExp(CTOR_INJECT_RE.source, 'g');
      let ctorMatch: RegExpExecArray | null;
      while ((ctorMatch = ctorRe.exec(source)) !== null) {
        const injections = extractCtorInjections(ctorMatch[1]);
        for (const svc of injections) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${className}#class`,
            targetNodeType: 'angular_service',
            edgeType: 'angular_injects',
            metadata: { service: svc },
          });
        }
      }
    }

    // --- Modules ---
    const ngModuleRe = new RegExp(NGMODULE_RE.source, 'g');
    while ((match = ngModuleRe.exec(source)) !== null) {
      const className = extractClassName(source, match.index);
      if (!className) continue;

      result.frameworkRole = result.frameworkRole ?? 'angular_module';

      // Extract module imports
      const importsRe = new RegExp(NGMODULE_IMPORTS_RE.source, 'gs');
      let importsMatch: RegExpExecArray | null;
      while ((importsMatch = importsRe.exec(source)) !== null) {
        const items = parseArrayItems(importsMatch[1]);
        for (const mod of items) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${className}#class`,
            targetNodeType: 'angular_module',
            edgeType: 'angular_imports_module',
            metadata: { module: mod },
          });
        }
      }

      // Extract module providers
      const providersRe = new RegExp(NGMODULE_PROVIDERS_RE.source, 'gs');
      let providersMatch: RegExpExecArray | null;
      while ((providersMatch = providersRe.exec(source)) !== null) {
        const items = parseArrayItems(providersMatch[1]);
        for (const svc of items) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${className}#class`,
            targetNodeType: 'angular_service',
            edgeType: 'angular_provides',
            metadata: { service: svc },
          });
        }
      }
    }

    // --- Directives ---
    const directiveRe = new RegExp(DIRECTIVE_RE.source, 'gs');
    while ((match = directiveRe.exec(source)) !== null) {
      const selector = match[1];
      const className = extractClassName(source, match.index);
      result.components!.push({
        name: className ?? selector,
        kind: 'component',
        props: { selector, directiveSelector: true },
        framework: 'angular',
      });
      result.frameworkRole = result.frameworkRole ?? 'angular_directive';
    }

    // --- Pipes ---
    const pipeRe = new RegExp(PIPE_RE.source, 'gs');
    while ((match = pipeRe.exec(source)) !== null) {
      const pipeName = match[1];
      const className = extractClassName(source, match.index);
      result.components!.push({
        name: className ?? pipeName,
        kind: 'provider',
        props: { pipeName },
        framework: 'angular',
      });
      result.frameworkRole = result.frameworkRole ?? 'angular_pipe';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}

// --- Helpers ---

const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio',
  'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
  'i', 'iframe', 'img', 'input', 'ins',
  'kbd',
  'label', 'legend', 'li', 'link',
  'main', 'map', 'mark', 'menu', 'meta', 'meter',
  'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output',
  'p', 'param', 'picture', 'pre', 'progress',
  'q',
  'rp', 'rt', 'ruby',
  's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small',
  'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'time', 'title', 'tr', 'track',
  'u', 'ul',
  'var', 'video',
  'wbr',
]);

function isHtmlTag(tag: string): boolean {
  return HTML_TAGS.has(tag.toLowerCase());
}
