/**
 * XML/XUL Language Plugin — custom extraction.
 *
 * Extracts: root element, elements with id/name attributes,
 * namespace declarations, XSD/WSDL types, XSLT templates.
 * Imports: xsl:import/include, xs:import/include, xi:include, script src.
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

/** 1-based line number from byte offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function sid(filePath: string, name: string, kind: string, ns?: string): string {
  return ns ? `${filePath}::${ns}::${name}#${kind}` : `${filePath}::${name}#${kind}`;
}

/**
 * Simple tag-aware XML scanner. Iterates opening tags and extracts
 * attributes with context (tag name), avoiding catastrophic backtracking.
 */
function* scanTags(source: string): Generator<{ tag: string; attrs: string; offset: number }> {
  // Match `<tagName ...>` or `<tagName .../>`, non-greedy on attrs.
  // Using indexOf loop instead of regex to avoid backtracking.
  let pos = 0;
  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt === -1) break;

    // Skip comments, CDATA, PIs, closing tags, declarations
    const next = source[lt + 1];
    if (next === '/' || next === '!' || next === '?') {
      pos = lt + 2;
      continue;
    }

    // Find end of tag
    const gt = source.indexOf('>', lt + 1);
    if (gt === -1) break;

    const tagContent = source.slice(lt + 1, gt);
    // Extract tag name: first run of [\w:.-]
    const nameMatch = tagContent.match(/^([a-zA-Z_][\w:.-]*)/);
    if (nameMatch) {
      yield {
        tag: nameMatch[1],
        attrs: tagContent.slice(nameMatch[0].length),
        offset: lt,
      };
    }
    pos = gt + 1;
  }
}

/** Extract attribute value by name from an attrs string. */
function getAttr(attrs: string, name: string): string | undefined {
  // Match name="value" or name='value'
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')` );
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

export class XmlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'xml-language',
    version: '1.0.0',
    priority: 8,
  };

  supportedExtensions = ['.xml', '.xul', '.xsl', '.xslt', '.xsd', '.wsdl', '.svg', '.plist'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    const seen = new Set<string>();

    const add = (name: string, kind: RawSymbol['kind'], offset: number, meta?: Record<string, unknown>) => {
      const id = sid(filePath, name, kind);
      if (seen.has(id)) return;
      seen.add(id);
      symbols.push({
        symbolId: id,
        name,
        kind,
        fqn: name,
        byteStart: offset,
        byteEnd: offset + name.length,
        lineStart: lineAt(source, offset),
        lineEnd: lineAt(source, offset),
        metadata: meta,
      });
    };

    let isFirstTag = true;

    for (const { tag, attrs, offset } of scanTags(source)) {
      const tagLocal = tag.includes(':') ? tag.split(':').pop()! : tag;

      // Root element — only first tag
      if (isFirstTag) {
        add(tag, 'type', offset, { xmlKind: 'rootElement' });
        isFirstTag = false;
      }

      // id attribute — always significant
      const idVal = getAttr(attrs, 'id');
      if (idVal) {
        add(idVal, 'constant', offset, { xmlKind: 'idElement', tag });
      }

      // name attribute — only on structural tags (not input/param/meta noise)
      const nameVal = getAttr(attrs, 'name');
      if (nameVal) {
        const noise = ['input', 'meta', 'param', 'option', 'select', 'textarea', 'button', 'form', 'a', 'img', 'link'];
        if (!noise.includes(tagLocal.toLowerCase())) {
          // XSD / WSDL / XSLT named definitions
          const xsdTypes = ['complextype', 'simpletype', 'element', 'attribute', 'attributegroup', 'group'];
          const wsdlTypes = ['message', 'porttype', 'binding', 'service', 'operation'];
          const xsltTypes = ['template', 'variable', 'param', 'key'];

          if (xsdTypes.includes(tagLocal.toLowerCase())) {
            add(nameVal, 'type', offset, { xmlKind: 'schemaType', tag });
          } else if (wsdlTypes.includes(tagLocal.toLowerCase())) {
            add(nameVal, tagLocal.toLowerCase() === 'operation' ? 'function' : 'type', offset, { xmlKind: 'wsdl', tag });
          } else if (xsltTypes.includes(tagLocal.toLowerCase())) {
            const kind = tagLocal.toLowerCase() === 'template' ? 'function' : 'variable';
            add(nameVal, kind, offset, { xmlKind: 'xslt', tag });
          } else {
            add(nameVal, 'constant', offset, { xmlKind: 'namedElement', tag });
          }
        }
      }

      // Namespace declarations: xmlns:prefix="uri"
      const nsRe = /xmlns:(\w+)\s*=\s*["']/g;
      let nsm: RegExpExecArray | null;
      while ((nsm = nsRe.exec(attrs)) !== null) {
        add(nsm[1], 'namespace', offset);
      }

      // Import edges — href on include/import tags
      const href = getAttr(attrs, 'href');
      if (href) {
        const importTags = ['import', 'include'];
        if (importTags.includes(tagLocal.toLowerCase())) {
          edges.push({ edgeType: 'imports', metadata: { module: href, tag } });
        }
      }

      // Import edges — schemaLocation
      const schemaLoc = getAttr(attrs, 'schemaLocation');
      if (schemaLoc) {
        // schemaLocation can be space-separated pairs: "namespace location namespace location"
        const parts = schemaLoc.trim().split(/\s+/);
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p.endsWith('.xsd') || p.endsWith('.wsdl') || p.startsWith('http')) {
            edges.push({ edgeType: 'imports', metadata: { module: p, tag } });
          }
        }
      }

      // Import edges — script src
      if (tagLocal.toLowerCase() === 'script') {
        const src = getAttr(attrs, 'src');
        if (src) {
          edges.push({ edgeType: 'imports', metadata: { module: src, tag: 'script' } });
        }
      }

      // Import edges — link href (stylesheets)
      if (tagLocal.toLowerCase() === 'link') {
        const rel = getAttr(attrs, 'rel');
        if (rel === 'stylesheet' && href) {
          edges.push({ edgeType: 'imports', metadata: { module: href, tag: 'link' } });
        }
      }
    }

    return ok({
      language: 'xml',
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
    });
  }
}
