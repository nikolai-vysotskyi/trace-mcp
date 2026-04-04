/**
 * HTML Language Plugin — regex-based extraction.
 *
 * Extracts: script/link references, id/class attributes, meta tags,
 * form elements, custom elements, and import edges to linked resources.
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

export class HtmlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'html-language',
    version: '1.0.0',
    priority: 6,
  };

  supportedExtensions = ['.html', '.htm'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    let byteOffset = 0;

    // --- Script tags ---
    const scriptRe = /<script\b([^>]*)(?:\/>|>([\s\S]*?)<\/script>)/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(source)) !== null) {
      const attrs = m[1];
      const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
      if (srcMatch) {
        edges.push({
          edgeType: 'imports',
          metadata: { from: srcMatch[1], kind: 'script' },
        });
      }
      // Inline script block
      if (m[2]?.trim()) {
        symbols.push({
          symbolId: `${filePath}::inline-script@${m.index}#variable`,
          name: 'inline-script',
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index + m[0].length),
          metadata: { inline: true, type: attrs.match(/type\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'text/javascript' },
        });
      }
    }

    // --- Link / stylesheet tags ---
    const linkRe = /<link\b([^>]*)>/gi;
    while ((m = linkRe.exec(source)) !== null) {
      const attrs = m[1];
      const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
      const rel = attrs.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1];
      if (href) {
        edges.push({
          edgeType: 'imports',
          metadata: { from: href, kind: rel ?? 'link' },
        });
      }
    }

    // --- IDs ---
    const idRe = /\bid\s*=\s*["']([^"']+)["']/gi;
    while ((m = idRe.exec(source)) !== null) {
      symbols.push({
        symbolId: `${filePath}::#${m[1]}#variable`,
        name: `#${m[1]}`,
        kind: 'variable',
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart: lineAt(source, m.index),
        lineEnd: lineAt(source, m.index),
        metadata: { htmlId: m[1] },
      });
    }

    // --- Custom elements (tags with a hyphen) ---
    const customElRe = /<([a-z][a-z0-9]*-[a-z0-9-]+)/gi;
    const seenCustom = new Set<string>();
    while ((m = customElRe.exec(source)) !== null) {
      const tag = m[1].toLowerCase();
      if (seenCustom.has(tag)) continue;
      seenCustom.add(tag);
      symbols.push({
        symbolId: `${filePath}::<${tag}>#variable`,
        name: `<${tag}>`,
        kind: 'variable',
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart: lineAt(source, m.index),
        lineEnd: lineAt(source, m.index),
        metadata: { customElement: true },
      });
    }

    // --- Meta tags (name/property) ---
    const metaRe = /<meta\b([^>]*)>/gi;
    while ((m = metaRe.exec(source)) !== null) {
      const attrs = m[1];
      const name = attrs.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
      const contentVal = attrs.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
      if (name) {
        symbols.push({
          symbolId: `${filePath}::meta:${name}#variable`,
          name: `meta:${name}`,
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { metaName: name, metaContent: contentVal },
        });
      }
    }

    // --- Form elements with name attribute ---
    const formElRe = /<(input|select|textarea|button)\b([^>]*)>/gi;
    while ((m = formElRe.exec(source)) !== null) {
      const tag = m[1];
      const attrs = m[2];
      const name = attrs.match(/name\s*=\s*["']([^"']+)["']/i)?.[1];
      if (name) {
        symbols.push({
          symbolId: `${filePath}::form:${name}#variable`,
          name: `form:${name}`,
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { formElement: tag, formName: name },
        });
      }
    }

    // --- Img src references ---
    const imgRe = /<img\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while ((m = imgRe.exec(source)) !== null) {
      edges.push({
        edgeType: 'imports',
        metadata: { from: m[1], kind: 'image' },
      });
    }

    return ok({
      language: 'html',
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
    });
  }
}

/** Get 1-based line number from byte offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}
