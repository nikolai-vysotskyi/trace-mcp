/**
 * DRFPlugin — Django REST Framework plugin.
 *
 * Detects 'djangorestframework' in Python dependencies and extracts:
 * - ModelSerializer → Django Model edges (drf_serializer_model)
 * - ViewSet → Serializer edges (drf_viewset_serializer)
 * - router.register() → ViewSet edges + REST route generation (drf_router_registers)
 * - ViewSet → Permission class edges (drf_permission_guards)
 *
 * Uses tree-sitter-python for AST-based extraction.
 */
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
import { getParser, type TSNode } from '../../../../../parser/tree-sitter.js';

// ============================================================
// Python dependency detection
// ============================================================

function hasPythonDep(rootPath: string, depName: string): boolean {
  // Check requirements.txt
  for (const reqFile of ['requirements.txt', 'requirements/base.txt', 'requirements/prod.txt']) {
    try {
      const content = fs.readFileSync(path.join(rootPath, reqFile), 'utf-8');
      if (new RegExp(`^${escapeRegExp(depName)}\\b`, 'm').test(content)) return true;
    } catch {
      /* not found */
    }
  }

  // Check pyproject.toml
  try {
    const content = fs.readFileSync(path.join(rootPath, 'pyproject.toml'), 'utf-8');
    if (content.includes(depName)) return true;
  } catch {
    /* not found */
  }

  // Check setup.py / setup.cfg
  for (const f of ['setup.py', 'setup.cfg']) {
    try {
      const content = fs.readFileSync(path.join(rootPath, f), 'utf-8');
      if (content.includes(depName)) return true;
    } catch {
      /* not found */
    }
  }

  // Check Pipfile
  try {
    const content = fs.readFileSync(path.join(rootPath, 'Pipfile'), 'utf-8');
    if (content.includes(depName)) return true;
  } catch {
    /* not found */
  }

  return false;
}

// ============================================================
// AST helpers
// ============================================================

/** Find all top-level class definitions (including decorated ones). */
function findClassDefinitions(root: TSNode): TSNode[] {
  const classes: TSNode[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'class_definition') {
      classes.push(child);
    } else if (child.type === 'decorated_definition') {
      const inner = child.namedChildren.find((c) => c.type === 'class_definition');
      if (inner) classes.push(inner);
    }
  }
  return classes;
}

/** Get superclass names from a class_definition node. */
function getSuperclasses(classDef: TSNode): string[] {
  const argList = classDef.childForFieldName('superclasses');
  if (!argList) return [];
  const names: string[] = [];
  for (const child of argList.namedChildren) {
    if (child.type === 'identifier') {
      names.push(child.text);
    } else if (child.type === 'attribute') {
      // e.g. serializers.ModelSerializer
      names.push(child.text);
    }
  }
  return names;
}

/** Get the class name from a class_definition node. */
function getClassName(classDef: TSNode): string {
  const nameNode = classDef.childForFieldName('name');
  return nameNode?.text ?? '';
}

/** Get the body node of a class. */
function getClassBody(classDef: TSNode): TSNode | null {
  return classDef.childForFieldName('body');
}

/** Find an assignment in a block by target name. Returns the RHS node. */
function findAssignment(body: TSNode, targetName: string): TSNode | null {
  for (const child of body.namedChildren) {
    if (child.type === 'expression_statement') {
      const expr = child.namedChildren[0];
      if (expr?.type === 'assignment') {
        const left = expr.childForFieldName('left');
        if (left?.type === 'identifier' && left.text === targetName) {
          return expr.childForFieldName('right');
        }
      }
    }
  }
  return null;
}

/** Find a nested class (like Meta) inside a class body. */
function findNestedClass(body: TSNode, name: string): TSNode | null {
  for (const child of body.namedChildren) {
    if (child.type === 'class_definition') {
      const n = child.childForFieldName('name');
      if (n?.text === name) return child;
    }
  }
  return null;
}

/** Extract list literal items as strings. Handles [Foo, Bar, ...] */
function extractListItems(node: TSNode): string[] {
  if (node.type === 'list') {
    return node.namedChildren
      .filter((c) => c.type === 'identifier' || c.type === 'attribute')
      .map((c) => c.text);
  }
  // Might be a tuple: (Foo, Bar)
  if (node.type === 'tuple') {
    return node.namedChildren
      .filter((c) => c.type === 'identifier' || c.type === 'attribute')
      .map((c) => c.text);
  }
  // Single identifier
  if (node.type === 'identifier') return [node.text];
  return [];
}

/** Strip the last dotted segment to get the short name. */
function shortName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : name;
}

// ============================================================
// DRF Serializer extraction
// ============================================================

interface SerializerInfo {
  className: string;
  modelName: string | null;
  line: number;
}

const SERIALIZER_BASES = new Set([
  'ModelSerializer',
  'serializers.ModelSerializer',
  'HyperlinkedModelSerializer',
  'serializers.HyperlinkedModelSerializer',
]);

function extractSerializers(root: TSNode): SerializerInfo[] {
  const result: SerializerInfo[] = [];
  for (const classDef of findClassDefinitions(root)) {
    const supers = getSuperclasses(classDef);
    const isModelSerializer = supers.some((s) => SERIALIZER_BASES.has(s));
    if (!isModelSerializer) continue;

    const className = getClassName(classDef);
    const body = getClassBody(classDef);
    if (!body) continue;

    let modelName: string | null = null;
    const metaClass = findNestedClass(body, 'Meta');
    if (metaClass) {
      const metaBody = getClassBody(metaClass);
      if (metaBody) {
        const modelRhs = findAssignment(metaBody, 'model');
        if (modelRhs) {
          modelName = shortName(modelRhs.text);
        }
      }
    }

    result.push({
      className,
      modelName,
      line: classDef.startPosition.row + 1,
    });
  }
  return result;
}

// ============================================================
// DRF ViewSet extraction
// ============================================================

interface ViewSetInfo {
  className: string;
  serializerClass: string | null;
  permissionClasses: string[];
  line: number;
}

const VIEWSET_BASES = new Set([
  'ModelViewSet',
  'viewsets.ModelViewSet',
  'ReadOnlyModelViewSet',
  'viewsets.ReadOnlyModelViewSet',
  'ViewSet',
  'viewsets.ViewSet',
  'GenericViewSet',
  'viewsets.GenericViewSet',
  'APIView',
  'GenericAPIView',
  'ListAPIView',
  'CreateAPIView',
  'RetrieveAPIView',
  'UpdateAPIView',
  'DestroyAPIView',
  'ListCreateAPIView',
  'RetrieveUpdateAPIView',
  'RetrieveDestroyAPIView',
  'RetrieveUpdateDestroyAPIView',
]);

function extractViewSets(root: TSNode): ViewSetInfo[] {
  const result: ViewSetInfo[] = [];
  for (const classDef of findClassDefinitions(root)) {
    const supers = getSuperclasses(classDef);
    const isViewSet = supers.some((s) => VIEWSET_BASES.has(s));
    if (!isViewSet) continue;

    const className = getClassName(classDef);
    const body = getClassBody(classDef);
    if (!body) continue;

    // serializer_class = UserSerializer
    let serializerClass: string | null = null;
    const serRhs = findAssignment(body, 'serializer_class');
    if (serRhs) {
      serializerClass = shortName(serRhs.text);
    }

    // permission_classes = [IsAuthenticated, IsAdminUser]
    let permissionClasses: string[] = [];
    const permRhs = findAssignment(body, 'permission_classes');
    if (permRhs) {
      permissionClasses = extractListItems(permRhs).map(shortName);
    }

    result.push({
      className,
      serializerClass,
      permissionClasses,
      line: classDef.startPosition.row + 1,
    });
  }
  return result;
}

// ============================================================
// DRF Router extraction
// ============================================================

interface RouterRegistration {
  prefix: string;
  viewsetName: string;
  line: number;
}

/**
 * Find router.register('prefix', ViewSet) calls.
 * Walks all call expressions in the AST.
 */
function extractRouterRegistrations(root: TSNode): RouterRegistration[] {
  const result: RouterRegistration[] = [];
  walkCalls(root, (callNode) => {
    const fn = callNode.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') return;
    if (fn.childForFieldName('attribute')?.text !== 'register') return;

    const args = callNode.childForFieldName('arguments');
    if (!args) return;

    const positional = args.namedChildren.filter(
      (c) => c.type !== 'keyword_argument' && c.type !== 'comment',
    );
    if (positional.length < 2) return;

    const prefixNode = positional[0];
    const viewsetNode = positional[1];

    // prefix should be a string literal
    let prefix = '';
    if (prefixNode.type === 'string') {
      prefix = stripQuotes(prefixNode.text);
    } else {
      return; // skip non-literal
    }

    const viewsetName = shortName(viewsetNode.text);

    result.push({
      prefix,
      viewsetName,
      line: callNode.startPosition.row + 1,
    });
  });
  return result;
}

/** Walk all call nodes in the tree. */
function walkCalls(node: TSNode, visitor: (call: TSNode) => void): void {
  if (node.type === 'call') {
    visitor(node);
  }
  for (const child of node.namedChildren) {
    walkCalls(child, visitor);
  }
}

function stripQuotes(s: string): string {
  // Handle f-strings, byte strings, etc.
  const raw = s.replace(/^[brufBRUF]*['"]/, '').replace(/['"]$/, '');
  return raw;
}

// ============================================================
// Standard CRUD routes for a DRF ViewSet
// ============================================================

function generateViewSetRoutes(prefix: string): RawRoute[] {
  const base = prefix.startsWith('/') ? prefix : `/${prefix}`;
  const trailing = base.endsWith('/') ? '' : '/';
  return [
    { method: 'GET', uri: `${base}${trailing}`, name: `${prefix}-list` },
    { method: 'POST', uri: `${base}${trailing}`, name: `${prefix}-create` },
    { method: 'GET', uri: `${base}${trailing}{pk}/`, name: `${prefix}-retrieve` },
    { method: 'PUT', uri: `${base}${trailing}{pk}/`, name: `${prefix}-update` },
    { method: 'PATCH', uri: `${base}${trailing}{pk}/`, name: `${prefix}-partial_update` },
    { method: 'DELETE', uri: `${base}${trailing}{pk}/`, name: `${prefix}-destroy` },
  ];
}

// ============================================================
// Plugin class
// ============================================================

export class DRFPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'drf',
    version: '1.0.0',
    priority: 30,
    category: 'api',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx.rootPath, 'djangorestframework');
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'drf_serializer_model',
          category: 'drf',
          description: 'ModelSerializer → Django Model',
        } as EdgeTypeDeclaration,
        {
          name: 'drf_viewset_serializer',
          category: 'drf',
          description: 'ViewSet → Serializer',
        } as EdgeTypeDeclaration,
        {
          name: 'drf_router_registers',
          category: 'drf',
          description: 'router.register() → ViewSet',
        } as EdgeTypeDeclaration,
        {
          name: 'drf_permission_guards',
          category: 'drf',
          description: 'ViewSet → Permission class',
        } as EdgeTypeDeclaration,
      ],
    };
  }

  async extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): Promise<TraceMcpResult<FileParseResult>> {
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
      const parser = await getParser('python');
      tree = parser.parse(source);
    } catch (e) {
      return err(parseError(filePath, `tree-sitter parse failed: ${e}`));
    }

    const root = tree.rootNode;

    // --- Serializers ---
    const serializers = extractSerializers(root);
    for (const ser of serializers) {
      if (ser.modelName) {
        result.edges!.push({
          edgeType: 'drf_serializer_model',
          sourceSymbolId: `${filePath}::${ser.className}#class`,
          targetSymbolId: ser.modelName, // resolved in pass 2
          metadata: { line: ser.line },
        });
      }
      result.frameworkRole = 'drf_serializer';
    }

    // --- ViewSets ---
    const viewsets = extractViewSets(root);
    for (const vs of viewsets) {
      if (vs.serializerClass) {
        result.edges!.push({
          edgeType: 'drf_viewset_serializer',
          sourceSymbolId: `${filePath}::${vs.className}#class`,
          targetSymbolId: vs.serializerClass, // resolved in pass 2
          metadata: { line: vs.line },
        });
      }

      for (const perm of vs.permissionClasses) {
        result.edges!.push({
          edgeType: 'drf_permission_guards',
          sourceSymbolId: `${filePath}::${vs.className}#class`,
          targetSymbolId: perm, // resolved in pass 2
          metadata: { line: vs.line },
        });
      }

      if (vs.serializerClass || vs.permissionClasses.length > 0) {
        result.frameworkRole = result.frameworkRole ?? 'drf_viewset';
      }
    }

    // --- Router registrations ---
    const registrations = extractRouterRegistrations(root);
    for (const reg of registrations) {
      result.edges!.push({
        edgeType: 'drf_router_registers',
        sourceSymbolId: `${filePath}::router_register_${reg.prefix}`,
        targetSymbolId: reg.viewsetName, // resolved in pass 2
        metadata: { prefix: reg.prefix, line: reg.line },
      });

      // Generate standard REST routes
      const routes = generateViewSetRoutes(reg.prefix);
      for (const route of routes) {
        result.routes!.push({
          ...route,
          line: reg.line,
        });
      }

      result.frameworkRole = result.frameworkRole ?? 'drf_router';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
