/**
 * Kotlin Language Plugin — regex-based symbol extraction.
 * Uses regex rather than tree-sitter-kotlin for reliability.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../errors.js';
import { parseError } from '../../../errors.js';

export class KotlinLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'kotlin-language',
    version: '1.0.0',
    priority: 5,
  };

  supportedExtensions = ['.kt', '.kts'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const source = content.toString('utf-8');
      const lines = source.split('\n');
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];

      // Package
      const pkgMatch = source.match(/^package\s+([\w.]+)/m);
      const packageName = pkgMatch?.[1];

      // Imports
      const importRe = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
      let im: RegExpExecArray | null;
      while ((im = importRe.exec(source)) !== null) {
        const parts = im[1].split('.');
        edges.push({
          edgeType: 'imports',
          metadata: {
            from: im[1],
            specifiers: [im[2] ?? parts[parts.length - 1]],
          },
        });
      }

      // Classes, interfaces, objects, enums
      const classRe = /^(\s*)(?:(@\w+(?:\([^)]*\))?)\s+)*(?:(abstract|sealed|data|open|inner|enum|annotation)\s+)*(?:(class|interface|object))\s+(\w+)(?:\s*(?:<[^>]+>)?)?(?:\s*\(([^)]*)\))?(?:\s*:\s*([^\{]+?))?(?:\s*\{)?/gm;
      let cm: RegExpExecArray | null;
      while ((cm = classRe.exec(source)) !== null) {
        const modifiers = cm[3] ?? '';
        const keyword = cm[4];
        const name = cm[5];
        const heritage = cm[7]?.trim();
        const lineNum = source.substring(0, cm.index).split('\n').length;
        const byteStart = cm.index;

        let kind: SymbolKind = 'class';
        if (keyword === 'interface') kind = 'interface';
        else if (keyword === 'object') kind = 'class';

        if (modifiers === 'enum') kind = 'enum';

        const meta: Record<string, unknown> = {};
        if (modifiers) meta.modifiers = modifiers;
        if (keyword === 'object') meta.object = true;
        if (modifiers === 'data') meta.data = true;

        if (heritage) {
          const parents = heritage.split(',').map((s) => s.trim().replace(/\(.*\)$/, '').trim());
          if (parents.length > 0) {
            // First is typically extends, rest are implements
            meta.extends = parents[0];
            if (parents.length > 1) meta.implements = parents.slice(1);
          }
        }

        const fqnParts = packageName ? [packageName, name] : [name];

        symbols.push({
          symbolId: `${filePath}::${name}#${kind}`,
          name,
          kind,
          fqn: fqnParts.join('.'),
          signature: cm[0].trim().replace(/\{$/, '').trim(),
          byteStart,
          byteEnd: byteStart + cm[0].length,
          lineStart: lineNum,
          lineEnd: lineNum,
          metadata: Object.keys(meta).length > 0 ? meta : undefined,
        });
      }

      // Functions (top-level and member)
      const funRe = /^(\s*)(?:(?:override|suspend|inline|private|public|protected|internal|open|abstract)\s+)*fun\s+(?:<[^>]+>\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\{=]+?))?/gm;
      let fm: RegExpExecArray | null;
      while ((fm = funRe.exec(source)) !== null) {
        const indent = fm[1].length;
        const name = fm[2];
        const lineNum = source.substring(0, fm.index).split('\n').length;

        const kind: SymbolKind = indent > 0 ? 'method' : 'function';
        const fqnParts = packageName ? [packageName, name] : [name];

        symbols.push({
          symbolId: `${filePath}::${name}#${kind}`,
          name,
          kind,
          fqn: fqnParts.join('.'),
          signature: fm[0].trim(),
          byteStart: fm.index,
          byteEnd: fm.index + fm[0].length,
          lineStart: lineNum,
          lineEnd: lineNum,
        });
      }

      // Properties (val/var at class level)
      const propRe = /^\s+(?:(?:override|private|public|protected|internal|lateinit|lazy|const)\s+)*(?:val|var)\s+(\w+)(?:\s*:\s*(\S+))?/gm;
      let pm: RegExpExecArray | null;
      while ((pm = propRe.exec(source)) !== null) {
        const name = pm[1];
        const lineNum = source.substring(0, pm.index).split('\n').length;

        symbols.push({
          symbolId: `${filePath}::${name}#property`,
          name,
          kind: 'property',
          signature: pm[0].trim(),
          byteStart: pm.index,
          byteEnd: pm.index + pm[0].length,
          lineStart: lineNum,
          lineEnd: lineNum,
          metadata: pm[2] ? { type: pm[2] } : undefined,
        });
      }

      // Top-level const val
      const constRe = /^(?:const\s+)?val\s+([A-Z][A-Z0-9_]+)\s*(?::\s*\S+)?\s*=/gm;
      let cc: RegExpExecArray | null;
      while ((cc = constRe.exec(source)) !== null) {
        const name = cc[1];
        const lineNum = source.substring(0, cc.index).split('\n').length;

        symbols.push({
          symbolId: `${filePath}::${name}#constant`,
          name,
          kind: 'constant',
          fqn: packageName ? `${packageName}.${name}` : name,
          signature: cc[0].trim(),
          byteStart: cc.index,
          byteEnd: cc.index + cc[0].length,
          lineStart: lineNum,
          lineEnd: lineNum,
        });
      }

      return ok({
        language: 'kotlin',
        status: 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Kotlin parse failed: ${msg}`));
    }
  }
}
