/**
 * DjangoPlugin — Framework plugin for Django applications.
 *
 * Orchestrates model, URL, signal, admin, form, and view extraction.
 *
 * Supports Django 2.x–5.x:
 * - Models: models.Model subclasses with ForeignKey/M2M/O2O relationships
 * - URLs: path(), re_path(), url(), include(), DRF routers
 * - Views: CBVs (ListView, DetailView, etc.) with model/template detection
 * - Admin: @admin.register(), admin.site.register()
 * - Signals: @receiver(), signal.connect()
 * - Forms: ModelForm with Meta.model
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
  EdgeTypeDeclaration,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';
import { escapeRegExp } from '../../../../../utils/security.js';
import { extractDjangoModels } from './models.js';
import { extractUrlPatterns } from './urls.js';
import { extractSignalConnections } from './signals.js';
import { extractAdminRegistrations } from './admin.js';

export class DjangoPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'django',
    version: '1.0.0',
    priority: 10,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    // Check for manage.py in config files
    if (ctx.configFiles.some((f) => path.basename(f) === 'manage.py')) {
      return true;
    }

    // Check for manage.py on disk
    try {
      fs.accessSync(path.join(ctx.rootPath, 'manage.py'), fs.constants.F_OK);
      return true;
    } catch {
      // continue to check pyproject.toml
    }

    // Check pyproject.toml for django dependency
    try {
      const pyprojectPath = path.join(ctx.rootPath, 'pyproject.toml');
      const content = fs.readFileSync(pyprojectPath, 'utf-8');
      if (/django/i.test(content) && /dependencies|requires/i.test(content)) {
        return true;
      }
    } catch {
      // continue to check requirements files
    }

    // Check requirements.txt or requirements/*.txt
    try {
      const reqPath = path.join(ctx.rootPath, 'requirements.txt');
      const content = fs.readFileSync(reqPath, 'utf-8');
      if (/^django(?:==|>=|<=|~=|!=|\[|\s|$)/im.test(content)) {
        return true;
      }
    } catch {
      // no requirements.txt
    }

    // Check setup.py / setup.cfg
    try {
      const setupPath = path.join(ctx.rootPath, 'setup.py');
      const content = fs.readFileSync(setupPath, 'utf-8');
      if (/['"]django['"]/i.test(content)) {
        return true;
      }
    } catch {
      // not found
    }

    return false;
  }

  registerSchema() {
    const edgeTypes: EdgeTypeDeclaration[] = [
      {
        name: 'django_url_routes_to',
        category: 'django',
        description: 'URL pattern routes to view',
      },
      {
        name: 'django_includes_urls',
        category: 'django',
        description: 'URL config includes another URL module',
      },
      {
        name: 'django_view_uses_model',
        category: 'django',
        description: 'View references a model',
      },
      { name: 'django_view_template', category: 'django', description: 'View renders a template' },
      {
        name: 'django_signal_receiver',
        category: 'django',
        description: 'Signal receiver connected to signal+sender',
      },
      {
        name: 'django_admin_registers',
        category: 'django',
        description: 'Admin class registers a model',
      },
      {
        name: 'django_form_meta_model',
        category: 'django',
        description: 'ModelForm Meta.model reference',
      },
    ];
    return { edgeTypes };
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
      ormModels: [],
      ormAssociations: [],
      warnings: [],
    };

    // --- Models ---
    const modelResults = extractDjangoModels(source, filePath);
    if (modelResults.length > 0) {
      result.frameworkRole = 'model';
      for (const mr of modelResults) {
        result.ormModels!.push(mr.model);
        result.ormAssociations!.push(...mr.associations);
      }
    }

    // --- URL patterns ---
    if (this.isUrlFile(filePath)) {
      const urlResult = extractUrlPatterns(source, filePath);
      result.routes = urlResult.routes;
      result.edges!.push(...urlResult.edges);
      result.frameworkRole = result.frameworkRole ?? 'url_config';
      if (urlResult.warnings.length > 0) {
        result.warnings!.push(...urlResult.warnings);
      }
    }

    // --- Views (CBV detection) ---
    this.extractViewEdges(source, filePath, result);

    // --- Signals ---
    const signalEdges = extractSignalConnections(source, filePath);
    if (signalEdges.length > 0) {
      result.edges!.push(...signalEdges);
      result.frameworkRole = result.frameworkRole ?? 'signals';
    }

    // --- Admin ---
    if (this.isAdminFile(filePath)) {
      const adminEdges = extractAdminRegistrations(source, filePath);
      if (adminEdges.length > 0) {
        result.edges!.push(...adminEdges);
        result.frameworkRole = result.frameworkRole ?? 'admin';
      }
    }

    // --- Forms (ModelForm Meta.model) ---
    this.extractFormEdges(source, filePath, result);

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const files = ctx.getAllFiles();

    for (const file of files) {
      if (file.language !== 'python') continue;

      let source: string;
      try {
        source = fs.readFileSync(path.resolve(ctx.rootPath, file.path), 'utf-8');
      } catch {
        continue;
      }

      // Resolve model relationship edges
      this.resolveModelEdges(source, file, ctx, edges);

      // Resolve admin → model edges
      this.resolveAdminEdges(source, file, ctx, edges);

      // Resolve signal → model edges
      this.resolveSignalEdges(source, file, ctx, edges);

      // Resolve form → model edges
      this.resolveFormEdges(source, file, ctx, edges);

      // Resolve view → model edges
      this.resolveViewModelEdges(source, file, ctx, edges);
    }

    return ok(edges);
  }

  // ============================================================
  // View extraction (CBV)
  // ============================================================

  /**
   * Extract class-based view information.
   * Detects model, template_name, queryset from CBV subclasses.
   */
  private extractViewEdges(source: string, filePath: string, result: FileParseResult): void {
    const cbvBases = [
      'ListView',
      'DetailView',
      'CreateView',
      'UpdateView',
      'DeleteView',
      'FormView',
      'TemplateView',
      'RedirectView',
      'GenericAPIView',
      'ModelViewSet',
      'ReadOnlyModelViewSet',
      'ListAPIView',
      'RetrieveAPIView',
      'CreateAPIView',
      'UpdateAPIView',
      'DestroyAPIView',
      'ListCreateAPIView',
      'RetrieveUpdateAPIView',
      'RetrieveDestroyAPIView',
      'RetrieveUpdateDestroyAPIView',
    ];

    const basesPattern = cbvBases.map(escapeRegExp).join('|');
    const classRegex = new RegExp(
      `class\\s+(\\w+)\\s*\\((?:[\\w.,\\s]*(?:${basesPattern})[\\w.,\\s]*)\\)\\s*:`,
      'g',
    );

    let classMatch: RegExpExecArray | null;
    while ((classMatch = classRegex.exec(source)) !== null) {
      const className = classMatch[1];
      const bodyStart = classMatch.index + classMatch[0].length;
      const body = this.extractIndentedBody(source, bodyStart);
      if (!body) continue;

      result.frameworkRole = result.frameworkRole ?? 'view';

      // Extract model = ModelName
      const modelMatch = body.match(/model\s*=\s*(\w+)/);
      if (modelMatch) {
        result.edges!.push({
          edgeType: 'django_view_uses_model',
          metadata: {
            viewClass: className,
            modelName: modelMatch[1],
            filePath,
          },
        });
      }

      // Extract queryset = Model.objects...
      const querysetMatch = body.match(/queryset\s*=\s*(\w+)\.objects/);
      if (querysetMatch && !modelMatch) {
        result.edges!.push({
          edgeType: 'django_view_uses_model',
          metadata: {
            viewClass: className,
            modelName: querysetMatch[1],
            filePath,
            via: 'queryset',
          },
        });
      }

      // Extract template_name = 'app/template.html'
      const templateMatch = body.match(/template_name\s*=\s*['"]([^'"]+)['"]/);
      if (templateMatch) {
        result.edges!.push({
          edgeType: 'django_view_template',
          metadata: {
            viewClass: className,
            templateName: templateMatch[1],
            filePath,
          },
        });
      }

      // Extract serializer_class (DRF)
      const serializerMatch = body.match(/serializer_class\s*=\s*(\w+)/);
      if (serializerMatch) {
        result.edges!.push({
          edgeType: 'django_view_uses_model',
          metadata: {
            viewClass: className,
            serializerClass: serializerMatch[1],
            filePath,
            via: 'serializer',
          },
        });
      }
    }
  }

  // ============================================================
  // Form extraction (ModelForm)
  // ============================================================

  /**
   * Extract ModelForm Meta.model references.
   */
  private extractFormEdges(source: string, filePath: string, result: FileParseResult): void {
    // Match class SomethingForm(ModelForm): or class SomethingForm(forms.ModelForm):
    const formRegex = /class\s+(\w+)\s*\(\s*(?:forms\.)?ModelForm\s*\)\s*:/g;
    let formMatch: RegExpExecArray | null;

    while ((formMatch = formRegex.exec(source)) !== null) {
      const formClass = formMatch[1];
      const bodyStart = formMatch.index + formMatch[0].length;
      const body = this.extractIndentedBody(source, bodyStart);
      if (!body) continue;

      result.frameworkRole = result.frameworkRole ?? 'form';

      // Find class Meta: with model = X
      const metaMatch = body.match(/class\s+Meta\s*:[\s\S]*?model\s*=\s*(\w+)/);
      if (metaMatch) {
        result.edges!.push({
          edgeType: 'django_form_meta_model',
          metadata: {
            formClass,
            modelName: metaMatch[1],
            filePath,
          },
        });
      }
    }
  }

  // ============================================================
  // Pass 2: Resolve edges with full symbol context
  // ============================================================

  private resolveModelEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const modelResults = extractDjangoModels(source, file.path);
    if (modelResults.length === 0) return;

    const symbols = ctx.getSymbolsByFile(file.id);

    for (const mr of modelResults) {
      const sourceClass = symbols.find((s) => s.kind === 'class' && s.name === mr.model.name);
      if (!sourceClass) continue;

      for (const assoc of mr.associations) {
        // Try to find the target model symbol
        const targetClass = this.findModelSymbol(ctx, assoc.targetModelName);
        if (!targetClass) continue;

        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: sourceClass.id,
          targetNodeType: 'symbol',
          targetRefId: targetClass.id,
          edgeType: `django_${assoc.kind}`,
          metadata: {
            fieldName: assoc.options?.field,
            kind: assoc.kind,
          },
        });
      }
    }
  }

  private resolveAdminEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    if (!this.isAdminFile(file.path)) return;

    const adminEdges = extractAdminRegistrations(source, file.path);
    const symbols = ctx.getSymbolsByFile(file.id);

    for (const edge of adminEdges) {
      const modelName = edge.metadata?.modelName as string;
      const adminClassName = edge.metadata?.adminClass as string | undefined;

      const modelSymbol = this.findModelSymbol(ctx, modelName);
      if (!modelSymbol) continue;

      const adminSymbol = adminClassName
        ? symbols.find((s) => s.kind === 'class' && s.name === adminClassName)
        : undefined;

      edges.push({
        sourceNodeType: adminSymbol ? 'symbol' : 'file',
        sourceRefId: adminSymbol ? adminSymbol.id : file.id,
        targetNodeType: 'symbol',
        targetRefId: modelSymbol.id,
        edgeType: 'django_admin_registers',
        metadata: { adminClass: adminClassName },
      });
    }
  }

  private resolveSignalEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const signalEdges = extractSignalConnections(source, file.path);
    if (signalEdges.length === 0) return;

    const symbols = ctx.getSymbolsByFile(file.id);

    for (const edge of signalEdges) {
      const sender = edge.metadata?.sender as string | undefined;
      if (!sender) continue;

      const senderSymbol = this.findModelSymbol(ctx, sender);
      if (!senderSymbol) continue;

      const handler = edge.metadata?.handler as string;
      const handlerSymbol = symbols.find((s) => s.kind === 'function' && s.name === handler);

      edges.push({
        sourceNodeType: handlerSymbol ? 'symbol' : 'file',
        sourceRefId: handlerSymbol ? handlerSymbol.id : file.id,
        targetNodeType: 'symbol',
        targetRefId: senderSymbol.id,
        edgeType: 'django_signal_receiver',
        metadata: {
          signal: edge.metadata?.signal,
          handler,
        },
      });
    }
  }

  private resolveFormEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const formRegex = /class\s+(\w+)\s*\(\s*(?:forms\.)?ModelForm\s*\)\s*:/g;
    let formMatch: RegExpExecArray | null;

    while ((formMatch = formRegex.exec(source)) !== null) {
      const formClass = formMatch[1];
      const bodyStart = formMatch.index + formMatch[0].length;
      const body = this.extractIndentedBody(source, bodyStart);
      if (!body) continue;

      const metaMatch = body.match(/class\s+Meta\s*:[\s\S]*?model\s*=\s*(\w+)/);
      if (!metaMatch) continue;

      const modelName = metaMatch[1];
      const symbols = ctx.getSymbolsByFile(file.id);
      const formSymbol = symbols.find((s) => s.kind === 'class' && s.name === formClass);
      const modelSymbol = this.findModelSymbol(ctx, modelName);

      if (formSymbol && modelSymbol) {
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: formSymbol.id,
          targetNodeType: 'symbol',
          targetRefId: modelSymbol.id,
          edgeType: 'django_form_meta_model',
        });
      }
    }
  }

  private resolveViewModelEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const cbvBases = [
      'ListView',
      'DetailView',
      'CreateView',
      'UpdateView',
      'DeleteView',
      'FormView',
      'TemplateView',
      'ModelViewSet',
      'ReadOnlyModelViewSet',
    ];
    const basesPattern = cbvBases.map(escapeRegExp).join('|');
    const classRegex = new RegExp(
      `class\\s+(\\w+)\\s*\\((?:[\\w.,\\s]*(?:${basesPattern})[\\w.,\\s]*)\\)\\s*:`,
      'g',
    );

    let classMatch: RegExpExecArray | null;
    while ((classMatch = classRegex.exec(source)) !== null) {
      const className = classMatch[1];
      const bodyStart = classMatch.index + classMatch[0].length;
      const body = this.extractIndentedBody(source, bodyStart);
      if (!body) continue;

      const symbols = ctx.getSymbolsByFile(file.id);
      const viewSymbol = symbols.find((s) => s.kind === 'class' && s.name === className);
      if (!viewSymbol) continue;

      // model = X
      const modelMatch = body.match(/model\s*=\s*(\w+)/);
      if (modelMatch) {
        const modelSymbol = this.findModelSymbol(ctx, modelMatch[1]);
        if (modelSymbol) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: viewSymbol.id,
            targetNodeType: 'symbol',
            targetRefId: modelSymbol.id,
            edgeType: 'django_view_uses_model',
          });
        }
      }

      // queryset = X.objects...
      const querysetMatch = body.match(/queryset\s*=\s*(\w+)\.objects/);
      if (querysetMatch && !modelMatch) {
        const modelSymbol = this.findModelSymbol(ctx, querysetMatch[1]);
        if (modelSymbol) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: viewSymbol.id,
            targetNodeType: 'symbol',
            targetRefId: modelSymbol.id,
            edgeType: 'django_view_uses_model',
            metadata: { via: 'queryset' },
          });
        }
      }
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private isUrlFile(filePath: string): boolean {
    return /urls\.py$/.test(filePath);
  }

  private isAdminFile(filePath: string): boolean {
    return /admin\.py$/.test(filePath) || /\/admin\//.test(filePath);
  }

  /**
   * Extract the indented body block after a class/def statement.
   */
  private extractIndentedBody(source: string, startIndex: number): string | null {
    const lines = source.substring(startIndex).split('\n');
    const bodyLines: string[] = [];
    let baseIndent: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimEnd();

      if (!trimmed) {
        bodyLines.push('');
        continue;
      }

      const indent = line.length - line.trimStart().length;

      if (baseIndent === null) {
        if (indent === 0 && i > 0) break;
        baseIndent = indent;
      }

      if (indent < baseIndent && trimmed.length > 0) break;

      bodyLines.push(trimmed);
    }

    const body = bodyLines.join('\n').trim();
    return body || null;
  }

  /**
   * Find a model symbol by name across the entire project.
   * Searches by class name (unqualified).
   */
  private findModelSymbol(
    ctx: ResolveContext,
    modelName: string,
  ): { id: number; symbolId: string } | undefined {
    // Try direct FQN match (in case it's fully qualified)
    const direct = ctx.getSymbolByFqn(modelName);
    if (direct) return direct;

    // Search all files for a class with this name
    // This is a simplified approach; a real implementation might build a name index
    const files = ctx.getAllFiles();
    for (const file of files) {
      if (file.language !== 'python') continue;
      const symbols = ctx.getSymbolsByFile(file.id);
      const match = symbols.find((s) => s.kind === 'class' && s.name === modelName);
      if (match) return match;
    }

    return undefined;
  }
}
