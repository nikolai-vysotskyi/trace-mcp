/**
 * FastAPIPlugin — Framework plugin for FastAPI (Python).
 *
 * Extracts:
 * - Route decorators: @app.get('/path'), @router.post('/path'), etc.
 * - Depends() dependency injection in function parameters
 * - Response model annotations on route decorators
 * - app.include_router() mounts
 *
 * Uses tree-sitter-python for AST parsing.
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
  RawRoute,
  EdgeTypeDeclaration,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { escapeRegExp } from '../../../../utils/security.js';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const PythonGrammar = require('tree-sitter-python');

/** HTTP methods recognized on FastAPI route decorators. */
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

/**
 * Check if a Python project has a given package in its dependencies.
 * Reads pyproject.toml parsed deps and requirements.txt from the ProjectContext,
 * falling back to reading files from disk.
 */
function hasPythonDep(ctx: ProjectContext, pkg: string): boolean {
  const lowerPkg = pkg.toLowerCase();

  // Check parsed pyproject.toml deps
  if (ctx.pyprojectToml) {
    const deps = ctx.pyprojectToml._parsedDeps as string[] | undefined;
    if (deps?.includes(lowerPkg)) return true;
  }

  // Check parsed requirements.txt
  if (ctx.requirementsTxt?.includes(lowerPkg)) return true;

  // Fallback: read from disk
  try {
    const pyprojectPath = path.join(ctx.rootPath, 'pyproject.toml');
    const content = fs.readFileSync(pyprojectPath, 'utf-8');
    const re = new RegExp(`["']${escapeRegExp(pkg)}[>=<\\[!~\\s"']`, 'i');
    if (re.test(content)) return true;
  } catch { /* not found */ }

  try {
    const reqPath = path.join(ctx.rootPath, 'requirements.txt');
    const content = fs.readFileSync(reqPath, 'utf-8');
    const re = new RegExp(`^${escapeRegExp(pkg)}\\b`, 'im');
    if (re.test(content)) return true;
  } catch { /* not found */ }

  return false;
}

export class FastAPIPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'fastapi',
    version: '1.0.0',
    priority: 10,
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'fastapi');
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'fastapi_route', category: 'fastapi', description: 'FastAPI route decorator → handler function' },
        { name: 'fastapi_depends', category: 'fastapi', description: 'FastAPI Depends() dependency injection' },
        { name: 'fastapi_request_model', category: 'fastapi', description: 'Route handler → Pydantic request model' },
        { name: 'fastapi_response_model', category: 'fastapi', description: 'Route decorator → Pydantic response model' },
        { name: 'fastapi_router_mounts', category: 'fastapi', description: 'app.include_router() mount' },
      ] satisfies EdgeTypeDeclaration[],
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
    // Quick check — skip files that don't mention fastapi-related patterns
    if (
      !source.includes('fastapi') &&
      !source.includes('FastAPI') &&
      !source.includes('APIRouter') &&
      !source.includes('@app.') &&
      !source.includes('@router.')
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      edges: [],
      warnings: [],
    };

    try {
      const parser = new Parser();
      parser.setLanguage(PythonGrammar);
      const tree = parser.parse(source);
      const root = tree.rootNode;

      this.extractRoutes(root, source, filePath, result);
      this.extractRouterMounts(root, source, filePath, result);
    } catch (e: unknown) {
      return err(parseError(filePath, `FastAPI parse error: ${e instanceof Error ? e.message : String(e)}`));
    }

    if (result.routes!.length > 0 || result.edges!.length > 0) {
      result.frameworkRole = 'fastapi_routes';
    }

    return ok(result);
  }

  /**
   * Extract route decorators from decorated_definition nodes.
   *
   * Patterns:
   *   @app.get("/path")
   *   @app.post("/path", response_model=Foo)
   *   @router.put("/path")
   */
  private extractRoutes(
    root: any,
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const decoratedDefs = this.findAllByType(root, 'decorated_definition');

    for (const decoratedDef of decoratedDefs) {
      // The function_definition is a child of the decorated_definition
      const funcDef = decoratedDef.children.find(
        (c: any) => c.type === 'function_definition',
      );
      if (!funcDef) continue;

      const funcName = funcDef.childForFieldName('name')?.text ?? 'unknown';
      const parameters = funcDef.childForFieldName('parameters');

      // Iterate decorators
      for (const child of decoratedDef.children) {
        if (child.type !== 'decorator') continue;

        const decoratorExpr = child.children.find(
          (c: any) => c.type === 'call' || c.type === 'attribute',
        );
        if (!decoratorExpr) continue;

        // Resolve the call expression: @app.get("/path") or @router.post("/path", ...)
        let callNode: any = null;
        if (decoratorExpr.type === 'call') {
          callNode = decoratorExpr;
        }
        if (!callNode) continue;

        const funcRef = callNode.childForFieldName('function');
        if (!funcRef || funcRef.type !== 'attribute') continue;

        const methodName = funcRef.childForFieldName('attribute')?.text;
        if (!methodName || !HTTP_METHODS.has(methodName)) continue;

        // Extract URI from the first positional argument
        const args = callNode.childForFieldName('arguments');
        if (!args) continue;

        const uri = this.extractFirstStringArg(args);
        if (!uri) continue;

        // Extract response_model keyword argument
        const responseModel = this.extractKeywordArg(args, 'response_model');

        const route: RawRoute = {
          method: methodName.toUpperCase(),
          uri,
          controllerSymbolId: funcName,
          line: funcDef.startPosition.row + 1,
        };
        result.routes!.push(route);

        // Emit fastapi_route edge
        result.edges!.push({
          edgeType: 'fastapi_route',
          metadata: {
            method: route.method,
            uri: route.uri,
            handler: funcName,
            filePath,
            line: route.line,
          },
        });

        // Emit fastapi_response_model edge if present
        if (responseModel) {
          result.edges!.push({
            edgeType: 'fastapi_response_model',
            metadata: {
              handler: funcName,
              responseModel,
              filePath,
            },
          });
        }

        // Extract Depends() from function parameters
        if (parameters) {
          this.extractDepends(parameters, funcName, filePath, result);
        }

        // Extract Pydantic request model from type-annotated parameters
        if (parameters) {
          this.extractRequestModels(parameters, funcName, filePath, result);
        }
      }
    }
  }

  /**
   * Extract Depends(some_func) from function parameters.
   *
   * Pattern: param: Type = Depends(get_db)
   * In the AST: default_parameter → default value is call with function named "Depends"
   */
  private extractDepends(
    parameters: any,
    funcName: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    for (const param of parameters.children) {
      if (param.type !== 'default_parameter' && param.type !== 'typed_default_parameter') continue;

      // Find the default value (the last significant child)
      const defaultValue = param.childForFieldName('value') ??
        param.children[param.children.length - 1];
      if (!defaultValue || defaultValue.type !== 'call') continue;

      const callFunc = defaultValue.childForFieldName('function');
      if (!callFunc) continue;

      // Check for Depends() or Depends
      const callFuncName = callFunc.text;
      if (callFuncName !== 'Depends') continue;

      // Extract the dependency function name from the first argument
      const callArgs = defaultValue.childForFieldName('arguments');
      if (!callArgs) continue;

      const depTarget = this.getFirstArgText(callArgs);
      if (!depTarget) continue;

      result.edges!.push({
        edgeType: 'fastapi_depends',
        metadata: {
          handler: funcName,
          dependency: depTarget,
          filePath,
        },
      });
    }
  }

  /**
   * Extract Pydantic request models from type annotations in parameters.
   *
   * Pattern: async def create_item(item: ItemCreate):
   * We look for typed_parameter nodes where the annotation is a capitalized identifier
   * (likely a Pydantic model). We skip basic types like str, int, float, bool, etc.
   */
  private extractRequestModels(
    parameters: any,
    funcName: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const builtinTypes = new Set([
      'str', 'int', 'float', 'bool', 'bytes', 'list', 'dict', 'tuple',
      'set', 'frozenset', 'None', 'Any', 'Optional', 'List', 'Dict',
      'Request', 'Response', 'HTTPException',
    ]);

    for (const param of parameters.children) {
      if (param.type !== 'typed_parameter' && param.type !== 'typed_default_parameter') continue;

      const annotation = param.childForFieldName('type');
      if (!annotation) continue;

      const typeName = annotation.text;
      // Skip builtin types and lowercase names (path params, query params)
      if (!typeName || builtinTypes.has(typeName) || /^[a-z]/.test(typeName)) continue;
      // Skip generic types like Optional[X], List[X]
      if (typeName.includes('[')) continue;

      result.edges!.push({
        edgeType: 'fastapi_request_model',
        metadata: {
          handler: funcName,
          requestModel: typeName,
          filePath,
        },
      });
    }
  }

  /**
   * Extract app.include_router(router, prefix='/api/v1') calls.
   */
  private extractRouterMounts(
    root: any,
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const calls = this.findAllByType(root, 'call');

    for (const call of calls) {
      const funcRef = call.childForFieldName('function');
      if (!funcRef || funcRef.type !== 'attribute') continue;

      const attr = funcRef.childForFieldName('attribute')?.text;
      if (attr !== 'include_router') continue;

      const args = call.childForFieldName('arguments');
      if (!args) continue;

      const routerName = this.getFirstArgText(args);
      const prefix = this.extractKeywordArg(args, 'prefix');
      const tags = this.extractKeywordArg(args, 'tags');

      if (routerName) {
        result.edges!.push({
          edgeType: 'fastapi_router_mounts',
          metadata: {
            router: routerName,
            prefix: prefix ?? '',
            tags: tags ?? '',
            filePath,
            line: call.startPosition.row + 1,
          },
        });
      }
    }
  }

  // ─── Tree-sitter helpers ───────────────────────────────────────────

  /** Recursively find all nodes of a given type. */
  private findAllByType(node: any, type: string): any[] {
    const results: any[] = [];
    if (node.type === type) results.push(node);
    for (const child of node.children ?? []) {
      results.push(...this.findAllByType(child, type));
    }
    return results;
  }

  /** Get the text of the first positional string argument in an argument_list. */
  private extractFirstStringArg(args: any): string | null {
    for (const child of args.children ?? []) {
      if (child.type === 'string') {
        return this.unquote(child.text);
      }
      // Handle concatenated_string
      if (child.type === 'concatenated_string') {
        return this.unquote(child.children[0]?.text ?? '');
      }
    }
    return null;
  }

  /** Get the text of the first positional (non-keyword) argument. */
  private getFirstArgText(args: any): string | null {
    for (const child of args.children ?? []) {
      if (child.type === 'keyword_argument' || child.type === '(' || child.type === ')' || child.type === ',') continue;
      return child.text;
    }
    return null;
  }

  /** Extract a keyword argument value as text. */
  private extractKeywordArg(args: any, name: string): string | null {
    for (const child of args.children ?? []) {
      if (child.type !== 'keyword_argument') continue;
      const key = child.childForFieldName('name')?.text;
      if (key !== name) continue;
      const value = child.childForFieldName('value');
      if (!value) continue;
      if (value.type === 'string') return this.unquote(value.text);
      return value.text;
    }
    return null;
  }

  /** Remove quotes from a Python string literal. */
  private unquote(s: string): string {
    // Handle triple-quoted, f-strings, etc.
    let text = s;
    // Strip leading f/b/r prefixes
    text = text.replace(/^[fFbBrRuU]+/, '');
    if (text.startsWith('"""') || text.startsWith("'''")) {
      return text.slice(3, -3);
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      return text.slice(1, -1);
    }
    return text;
  }
}
