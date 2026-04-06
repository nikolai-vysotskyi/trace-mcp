/**
 * FlaskPlugin — Framework plugin for Flask (Python).
 *
 * Extracts:
 * - Route decorators: @app.route('/path', methods=['GET', 'POST'])
 * - Blueprint routes: @bp.route('/path')
 * - Blueprint registration: app.register_blueprint(bp, url_prefix='/api')
 * - Before-request hooks: @app.before_request
 * - Error handlers: @app.errorhandler(404)
 *
 * Uses tree-sitter-python for AST parsing.
 */
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
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';
import { parseError } from '../../../../../errors.js';
import { escapeRegExp } from '../../../../../utils/security.js';
import { getParser } from '../../../../../parser/tree-sitter.js';

/** Default HTTP method when none specified in @app.route(). */
const DEFAULT_METHODS = ['GET'];

/**
 * Check if a Python project has a given package in its dependencies.
 */
function hasPythonDep(ctx: ProjectContext, pkg: string): boolean {
  const lowerPkg = pkg.toLowerCase();

  if (ctx.pyprojectToml) {
    const deps = ctx.pyprojectToml._parsedDeps as string[] | undefined;
    if (deps?.includes(lowerPkg)) return true;
  }

  if (ctx.requirementsTxt?.includes(lowerPkg)) return true;

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

export class FlaskPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'flask',
    version: '1.0.0',
    priority: 10,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'flask');
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'flask_route', category: 'flask', description: 'Flask route decorator → handler function' },
        { name: 'flask_blueprint_mounts', category: 'flask', description: 'app.register_blueprint() mount' },
        { name: 'flask_before_request', category: 'flask', description: '@app.before_request hook' },
        { name: 'flask_error_handler', category: 'flask', description: '@app.errorhandler() registration' },
      ] satisfies EdgeTypeDeclaration[],
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
    // Quick check — skip files without flask-related patterns
    if (
      !source.includes('flask') &&
      !source.includes('Flask') &&
      !source.includes('Blueprint') &&
      !source.includes('@app.') &&
      !source.includes('@bp.') &&
      !source.includes('.route(')
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
      const parser = await getParser('python');
      const tree = parser.parse(source);
      const root = tree.rootNode;

      this.extractRoutes(root, source, filePath, result);
      this.extractBlueprintMounts(root, source, filePath, result);
      this.extractBeforeRequestHooks(root, source, filePath, result);
      this.extractErrorHandlers(root, source, filePath, result);
    } catch (e: unknown) {
      return err(parseError(filePath, `Flask parse error: ${e instanceof Error ? e.message : String(e)}`));
    }

    if (result.routes!.length > 0 || result.edges!.length > 0) {
      result.frameworkRole = 'flask_routes';
    }

    return ok(result);
  }

  /**
   * Extract route decorators from decorated_definition nodes.
   *
   * Patterns:
   *   @app.route('/path')                          → GET
   *   @app.route('/path', methods=['GET', 'POST']) → GET, POST
   *   @bp.route('/path')                           → GET
   */
  private extractRoutes(
    root: any,
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const decoratedDefs = this.findAllByType(root, 'decorated_definition');

    for (const decoratedDef of decoratedDefs) {
      const funcDef = decoratedDef.children.find(
        (c: any) => c.type === 'function_definition',
      );
      if (!funcDef) continue;

      const funcName = funcDef.childForFieldName('name')?.text ?? 'unknown';

      for (const child of decoratedDef.children) {
        if (child.type !== 'decorator') continue;

        const callNode = child.children.find((c: any) => c.type === 'call');
        if (!callNode) continue;

        const funcRef = callNode.childForFieldName('function');
        if (!funcRef || funcRef.type !== 'attribute') continue;

        const attrName = funcRef.childForFieldName('attribute')?.text;
        if (attrName !== 'route') continue;

        const args = callNode.childForFieldName('arguments');
        if (!args) continue;

        // Extract URI from first positional string argument
        const uri = this.extractFirstStringArg(args);
        if (!uri) continue;

        // Extract methods keyword argument: methods=['GET', 'POST']
        const methods = this.extractMethodsArg(args) ?? DEFAULT_METHODS;

        // Emit one RawRoute per method
        for (const method of methods) {
          const route: RawRoute = {
            method: method.toUpperCase(),
            uri,
            controllerSymbolId: funcName,
            line: funcDef.startPosition.row + 1,
          };
          result.routes!.push(route);

          result.edges!.push({
            edgeType: 'flask_route',
            metadata: {
              method: route.method,
              uri: route.uri,
              handler: funcName,
              filePath,
              line: route.line,
            },
          });
        }
      }
    }
  }

  /**
   * Extract app.register_blueprint(bp, url_prefix='/api') calls.
   */
  private extractBlueprintMounts(
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
      if (attr !== 'register_blueprint') continue;

      const args = call.childForFieldName('arguments');
      if (!args) continue;

      const blueprintName = this.getFirstArgText(args);
      const urlPrefix = this.extractKeywordArg(args, 'url_prefix');

      if (blueprintName) {
        result.edges!.push({
          edgeType: 'flask_blueprint_mounts',
          metadata: {
            blueprint: blueprintName,
            urlPrefix: urlPrefix ?? '',
            filePath,
            line: call.startPosition.row + 1,
          },
        });
      }
    }
  }

  /**
   * Extract @app.before_request / @bp.before_request hooks.
   */
  private extractBeforeRequestHooks(
    root: any,
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const decoratedDefs = this.findAllByType(root, 'decorated_definition');

    for (const decoratedDef of decoratedDefs) {
      const funcDef = decoratedDef.children.find(
        (c: any) => c.type === 'function_definition',
      );
      if (!funcDef) continue;

      const funcName = funcDef.childForFieldName('name')?.text ?? 'unknown';

      for (const child of decoratedDef.children) {
        if (child.type !== 'decorator') continue;

        // @app.before_request is an attribute access, not a call
        const attrNode = child.children.find((c: any) => c.type === 'attribute');
        if (!attrNode) continue;

        const attrName = attrNode.childForFieldName('attribute')?.text;
        if (attrName !== 'before_request' && attrName !== 'before_app_request') continue;

        result.edges!.push({
          edgeType: 'flask_before_request',
          metadata: {
            handler: funcName,
            hookType: attrName,
            filePath,
            line: funcDef.startPosition.row + 1,
          },
        });
      }
    }
  }

  /**
   * Extract @app.errorhandler(404) / @app.errorhandler(Exception) decorators.
   */
  private extractErrorHandlers(
    root: any,
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const decoratedDefs = this.findAllByType(root, 'decorated_definition');

    for (const decoratedDef of decoratedDefs) {
      const funcDef = decoratedDef.children.find(
        (c: any) => c.type === 'function_definition',
      );
      if (!funcDef) continue;

      const funcName = funcDef.childForFieldName('name')?.text ?? 'unknown';

      for (const child of decoratedDef.children) {
        if (child.type !== 'decorator') continue;

        const callNode = child.children.find((c: any) => c.type === 'call');
        if (!callNode) continue;

        const funcRef = callNode.childForFieldName('function');
        if (!funcRef || funcRef.type !== 'attribute') continue;

        const attrName = funcRef.childForFieldName('attribute')?.text;
        if (attrName !== 'errorhandler') continue;

        const args = callNode.childForFieldName('arguments');
        const errorCode = args ? this.getFirstArgText(args) : 'unknown';

        result.edges!.push({
          edgeType: 'flask_error_handler',
          metadata: {
            handler: funcName,
            errorCode: errorCode ?? 'unknown',
            filePath,
            line: funcDef.startPosition.row + 1,
          },
        });
      }
    }
  }

  // ─── Tree-sitter helpers ───────────────────────────────────────────

  private findAllByType(node: any, type: string): any[] {
    const results: any[] = [];
    if (node.type === type) results.push(node);
    for (const child of node.children ?? []) {
      results.push(...this.findAllByType(child, type));
    }
    return results;
  }

  private extractFirstStringArg(args: any): string | null {
    for (const child of args.children ?? []) {
      if (child.type === 'string') {
        return this.unquote(child.text);
      }
      if (child.type === 'concatenated_string') {
        return this.unquote(child.children[0]?.text ?? '');
      }
    }
    return null;
  }

  private getFirstArgText(args: any): string | null {
    for (const child of args.children ?? []) {
      if (child.type === 'keyword_argument' || child.type === '(' || child.type === ')' || child.type === ',') continue;
      return child.text;
    }
    return null;
  }

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

  /**
   * Extract methods=['GET', 'POST'] keyword argument.
   * Returns an array of method strings, or null if not found.
   */
  private extractMethodsArg(args: any): string[] | null {
    for (const child of args.children ?? []) {
      if (child.type !== 'keyword_argument') continue;
      const key = child.childForFieldName('name')?.text;
      if (key !== 'methods') continue;
      const value = child.childForFieldName('value');
      if (!value) continue;

      // value should be a list: ['GET', 'POST']
      if (value.type === 'list') {
        const methods: string[] = [];
        for (const item of value.children ?? []) {
          if (item.type === 'string') {
            methods.push(this.unquote(item.text));
          }
        }
        return methods.length > 0 ? methods : null;
      }
    }
    return null;
  }

  private unquote(s: string): string {
    let text = s;
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
