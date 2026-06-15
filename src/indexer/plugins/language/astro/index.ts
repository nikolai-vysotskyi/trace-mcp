/**
 * Astro Language Plugin — extracts symbols from .astro single-file components.
 *
 * Astro v6 file structure:
 *   ---                    ← optional frontmatter fence
 *   TypeScript/JavaScript
 *   ---                    ← closing fence
 *   HTML template body     ← may contain <script> and <style> blocks
 *
 * Strategy (no external grammar dependency — delegates to existing tree-sitter grammars):
 *  - Frontmatter: re-parsed as TypeScript via tree-sitter to extract ESM imports
 *    and declared symbols.
 *  - Template body: regex-based extraction of custom component tags (PascalCase /
 *    kebab-case) and `id` attribute constants.
 *  - <script> blocks: inferred lang (ts/tsx → typescript, js/jsx → javascript),
 *    re-parsed via tree-sitter for imports + module call sites. JSON/inline blocks skipped.
 *  - <style> blocks: surfaced in metadata only (lang/presence), no deep parse.
 *
 * Fail-soft: UTF-8 BOM, CRLF line endings, malformed/unclosed frontmatter fences
 * are all handled gracefully — the plugin never throws on malformed input.
 */

import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawComponent,
  RawEdge,
  RawSymbol,
} from '../../../../plugin-api/types.js';
import {
  extractCallSites,
  extractImportEdges,
  extractModuleCallSites,
  extractTypeReferences,
  makeSymbolId,
  type TSNode,
} from '../typescript/helpers.js';
import {
  componentNameFromPath,
  extractIdConstants,
  extractScriptBlocks,
  extractStyleBlocks,
  extractTemplateComponents,
  splitAstroSections,
} from './helpers.js';

export class AstroLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'astro-language',
    version: '1.0.0',
    // Slightly lower priority than Vue (10) — Astro is newer and less common
    // in existing codebases; let more established plugins run first.
    priority: 12,
  };

  supportedExtensions = ['.astro'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const rawSource = content.toString('utf-8');
      const sections = splitAstroSections(rawSource);

      const warnings: string[] = [];
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      let status: 'ok' | 'partial' = 'ok';

      const componentName = componentNameFromPath(filePath);
      const componentSymbolId = makeSymbolId(filePath, componentName, 'class');
      const totalLines =
        sections.frontmatter !== null
          ? sections.templateLineStart + sections.template.split('\n').length - 1
          : sections.template.split('\n').length;

      // Top-level component symbol representing the .astro file as a whole.
      symbols.push({
        symbolId: componentSymbolId,
        name: componentName,
        kind: 'class',
        byteStart: 0,
        byteEnd: content.length,
        lineStart: 1,
        lineEnd: totalLines,
        metadata: {
          framework: 'astro',
          sfc: true,
        },
      });

      // ── Frontmatter (TypeScript/JavaScript between --- fences) ───────────
      if (sections.frontmatter !== null) {
        const fmContent = sections.frontmatter;
        const fmLineOffset = sections.frontmatterLineStart - 1;
        const fmByteOffset = sections.frontmatterOffset;

        // Extract import edges from the frontmatter.
        const fmEdges = await this.parseScriptEdges(fmContent, 'typescript');
        // Adjust edge metadata — edges themselves have no byte offsets so no adjustment needed.
        edges.push(...fmEdges);

        // Extract individual symbols declared in the frontmatter.
        const fmSymbols = await this.parseFrontmatterSymbols(
          fmContent,
          filePath,
          fmLineOffset,
          fmByteOffset,
        );
        symbols.push(...fmSymbols);

        // Build a module-level pseudo-symbol for the frontmatter body to
        // capture call sites and type references (same pattern as Vue plugin).
        const fmModuleSym = await this.buildModuleSymbol(
          fmContent,
          filePath,
          fmLineOffset,
          fmByteOffset,
          '_frontmatter',
        );
        if (fmModuleSym) symbols.push(fmModuleSym);
      }

      // ── Template body ────────────────────────────────────────────────────
      const templateContent = sections.template;
      const templateLineOffset = sections.templateLineStart - 1;
      const templateByteOffset = sections.templateOffset;

      // Extract component usage edges from the template.
      const templateComponents = extractTemplateComponents(templateContent);

      // Extract id="..." constants from the template.
      const idConstants = extractIdConstants(templateContent);
      for (const { name, offset } of idConstants) {
        const absOffset = templateByteOffset + offset;
        const lineStart = templateLineOffset + countLinesUpTo(templateContent, offset) + 1;
        symbols.push({
          symbolId: makeSymbolId(filePath, name, 'constant'),
          name,
          kind: 'constant',
          byteStart: absOffset,
          byteEnd: absOffset + name.length,
          lineStart,
          lineEnd: lineStart,
          metadata: { htmlId: true },
        });
      }

      // ── <script> blocks inside the template ─────────────────────────────
      const scriptBlocks = extractScriptBlocks(templateContent);
      for (const block of scriptBlocks) {
        if (block.isInline) continue; // is:inline blocks are not processed by Astro

        const scriptEdges = await this.parseScriptEdges(block.content, block.lang);
        edges.push(...scriptEdges);

        const scriptModuleSym = await this.buildModuleSymbol(
          block.content,
          filePath,
          templateLineOffset + countLinesUpTo(templateContent, block.contentOffset),
          templateByteOffset + block.contentOffset,
          `_script`,
        );
        if (scriptModuleSym) symbols.push(scriptModuleSym);
      }

      // ── <style> blocks ───────────────────────────────────────────────────
      const styleBlocks = extractStyleBlocks(templateContent);
      const styleLangs = [...new Set(styleBlocks.map((b) => b.lang))];

      // ── Attach template metadata to the top-level component symbol ───────
      const compMeta = symbols[0].metadata as Record<string, unknown>;
      if (templateComponents.length > 0) compMeta.templateComponents = templateComponents;
      if (styleLangs.length > 0) compMeta.styleLangs = styleLangs;
      if (scriptBlocks.length > 0) compMeta.hasClientScripts = true;

      // ── RawComponent ─────────────────────────────────────────────────────
      const component: RawComponent = {
        name: componentName,
        kind: 'component',
        framework: 'astro',
      };

      return ok({
        language: 'astro',
        status,
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        components: [component],
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Astro parse failed: ${msg}`));
    }
  }

  /**
   * Parse a script/frontmatter block with tree-sitter to extract import edges.
   */
  private async parseScriptEdges(
    scriptContent: string,
    lang: 'typescript' | 'javascript',
  ): Promise<RawEdge[]> {
    try {
      const parser = await getParser(lang);
      const tree = parser.parse(scriptContent);
      try {
        return extractImportEdges(tree.rootNode as TSNode);
      } finally {
        tree.delete();
      }
    } catch {
      return [];
    }
  }

  /**
   * Parse the frontmatter block with tree-sitter to extract top-level symbol declarations.
   * Line and byte offsets are adjusted to be absolute within the .astro file.
   */
  private async parseFrontmatterSymbols(
    fmContent: string,
    filePath: string,
    lineOffset: number,
    byteOffset: number,
  ): Promise<RawSymbol[]> {
    try {
      const parser = await getParser('typescript');
      const tree = parser.parse(fmContent);
      try {
        const root = tree.rootNode as TSNode;
        const symbols: RawSymbol[] = [];

        for (const node of root.namedChildren) {
          // Unwrap export statements.
          const target =
            node.type === 'export_statement'
              ? (node.namedChildren.find(
                  (c) =>
                    c.type === 'function_declaration' ||
                    c.type === 'class_declaration' ||
                    c.type === 'lexical_declaration' ||
                    c.type === 'type_alias_declaration' ||
                    c.type === 'interface_declaration' ||
                    c.type === 'enum_declaration',
                ) ?? null)
              : node;

          if (!target) continue;
          this.extractFrontmatterNode(target, filePath, symbols, lineOffset, byteOffset);
        }

        return symbols;
      } finally {
        tree.delete();
      }
    } catch {
      return [];
    }
  }

  private extractFrontmatterNode(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    lineOffset: number,
    byteOffset: number,
  ): void {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text;
    if (!name) return;

    let kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | undefined;
    switch (node.type) {
      case 'function_declaration':
        kind = 'function';
        break;
      case 'class_declaration':
        kind = 'class';
        break;
      case 'lexical_declaration':
      case 'variable_declarator':
        kind = 'variable';
        break;
      case 'type_alias_declaration':
        kind = 'type';
        break;
      case 'interface_declaration':
        kind = 'interface';
        break;
      case 'enum_declaration':
        kind = 'enum';
        break;
    }

    if (!kind) return;

    const metadata: Record<string, unknown> = {};
    if (kind === 'function' || kind === 'class') {
      const callSites = extractCallSites(node);
      if (callSites.length > 0) metadata.callSites = callSites;
      const typeRefs = extractTypeReferences(node);
      if (typeRefs.length > 0) metadata.typeRefs = typeRefs;
    }

    symbols.push({
      symbolId: makeSymbolId(filePath, name, kind),
      name,
      kind,
      byteStart: byteOffset + node.startIndex,
      byteEnd: byteOffset + node.endIndex,
      lineStart: lineOffset + node.startPosition.row + 1,
      lineEnd: lineOffset + node.endPosition.row + 1,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  /**
   * Build a synthetic `__module__` pseudo-symbol for a script/frontmatter body.
   * Captures module-level call sites and type references for the call graph,
   * following the same pattern as the Vue plugin.
   */
  private async buildModuleSymbol(
    scriptContent: string,
    filePath: string,
    lineOffset: number,
    byteOffset: number,
    suffix: string,
  ): Promise<RawSymbol | null> {
    try {
      const parser = await getParser('typescript');
      const tree = parser.parse(scriptContent);
      try {
        const root = tree.rootNode as TSNode;
        const callSites = extractModuleCallSites(root, { skipLexicalFunctionBodies: false });
        const typeRefs = extractTypeReferences(root);
        if (callSites.length === 0 && typeRefs.length === 0) return null;

        const baseName =
          filePath
            .split('/')
            .pop()
            ?.replace(/\.astro$/, '') ?? '__module__';
        const tag = `__module__${suffix}`;

        return {
          symbolId: makeSymbolId(filePath, tag, 'namespace'),
          name: `${tag}:${baseName}`,
          kind: 'namespace',
          signature: `(astro ${suffix.replace('_', '')} body) ${filePath}`,
          byteStart: byteOffset,
          byteEnd: byteOffset + scriptContent.length,
          lineStart: lineOffset + 1,
          lineEnd: lineOffset + scriptContent.split('\n').length,
          metadata: {
            synthetic: true,
            moduleBody: true,
            ...(callSites.length > 0 ? { callSites } : {}),
            ...(typeRefs.length > 0 ? { typeRefs } : {}),
          },
        };
      } finally {
        tree.delete();
      }
    } catch {
      return null;
    }
  }
}

/** Count the number of newlines in str[0..offset). */
function countLinesUpTo(str: string, offset: number): number {
  let count = 0;
  for (let i = 0; i < offset; i++) {
    if (str[i] === '\n') count++;
  }
  return count;
}
