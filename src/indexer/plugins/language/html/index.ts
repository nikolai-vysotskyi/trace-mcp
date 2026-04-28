/**
 * HTML Language Plugin — tree-sitter-based extraction.
 *
 * Extracts: script/link references, id/class attributes, meta tags,
 * form elements, custom elements, and import edges to linked resources.
 */
import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
} from '../../../../plugin-api/types.js';

const FORM_TAGS = new Set(['input', 'select', 'textarea', 'button']);

/** Extract an attribute value from a start_tag or self_closing_tag node. */
function getAttr(node: TSNode, name: string): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'attribute') {
      const attrName = child.childForFieldName('name') ?? child.namedChildren[0];
      if (attrName?.text === name) {
        const attrValue = child.childForFieldName('value') ?? child.namedChildren[1];
        if (attrValue) {
          const text = attrValue.text;
          return text.replace(/^["']|["']$/g, '');
        }
      }
    }
  }
  return undefined;
}

export class HtmlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'html-language',
    version: '2.0.0',
    priority: 6,
  };

  supportedExtensions = ['.html', '.htm'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('html');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];
      const seenCustom = new Set<string>();

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walk(root, filePath, symbols, edges, seenCustom);

      return ok({
        language: 'html',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `HTML parse failed: ${msg}`));
    }
  }

  /** Recursively walk the AST and extract symbols/edges. */
  private walk(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seenCustom: Set<string>,
  ): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'element':
        case 'script_element':
        case 'style_element':
          this.processElement(child, filePath, symbols, edges, seenCustom);
          break;
        case 'self_closing_tag':
          this.processTag(child, child, filePath, symbols, edges, seenCustom);
          break;
        case 'doctype':
          // Skip doctype declarations
          break;
        default:
          // Recurse into other node types (fragments, etc.)
          this.walk(child, filePath, symbols, edges, seenCustom);
          break;
      }
    }
  }

  /** Process an element node (has start_tag, content children, end_tag). */
  private processElement(
    element: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seenCustom: Set<string>,
  ): void {
    const startTag = element.namedChildren.find(
      (c) => c.type === 'start_tag' || c.type === 'self_closing_tag',
    );

    if (startTag) {
      this.processTag(startTag, element, filePath, symbols, edges, seenCustom);
    }

    // Recurse into child elements
    this.walk(element, filePath, symbols, edges, seenCustom);
  }

  /** Process a start_tag or self_closing_tag to extract symbols and edges. */
  private processTag(
    tag: TSNode,
    element: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seenCustom: Set<string>,
  ): void {
    const tagNameNode = tag.namedChildren.find((c) => c.type === 'tag_name');
    if (!tagNameNode) return;
    const tagName = tagNameNode.text.toLowerCase();

    // --- Script tags ---
    if (tagName === 'script') {
      const src = getAttr(tag, 'src');
      if (src) {
        edges.push({
          edgeType: 'imports',
          metadata: { from: src, kind: 'script' },
        });
      }
      // Inline script block — check for raw_text content in the element
      if (!src) {
        const rawText = element.namedChildren.find((c) => c.type === 'raw_text');
        if (rawText?.text.trim()) {
          const scriptType = getAttr(tag, 'type') ?? 'text/javascript';
          symbols.push({
            symbolId: `${filePath}::inline-script@${element.startIndex}#variable`,
            name: 'inline-script',
            kind: 'variable',
            byteStart: element.startIndex,
            byteEnd: element.endIndex,
            lineStart: element.startPosition.row + 1,
            lineEnd: element.endPosition.row + 1,
            metadata: { inline: true, type: scriptType },
          });
        }
      }
      return;
    }

    // --- Link / stylesheet tags ---
    if (tagName === 'link') {
      const href = getAttr(tag, 'href');
      const rel = getAttr(tag, 'rel');
      if (href) {
        edges.push({
          edgeType: 'imports',
          metadata: { from: href, kind: rel ?? 'link' },
        });
      }
      return;
    }

    // --- Meta tags ---
    if (tagName === 'meta') {
      const name = getAttr(tag, 'name') ?? getAttr(tag, 'property');
      const contentVal = getAttr(tag, 'content');
      if (name) {
        symbols.push({
          symbolId: `${filePath}::meta:${name}#variable`,
          name: `meta:${name}`,
          kind: 'variable',
          byteStart: element.startIndex,
          byteEnd: element.endIndex,
          lineStart: element.startPosition.row + 1,
          lineEnd: element.endPosition.row + 1,
          metadata: { metaName: name, metaContent: contentVal },
        });
      }
      return;
    }

    // --- Img src references ---
    if (tagName === 'img') {
      const src = getAttr(tag, 'src');
      if (src) {
        edges.push({
          edgeType: 'imports',
          metadata: { from: src, kind: 'image' },
        });
      }
    }

    // --- Form elements with name attribute ---
    if (FORM_TAGS.has(tagName)) {
      const name = getAttr(tag, 'name');
      if (name) {
        symbols.push({
          symbolId: `${filePath}::form:${name}#variable`,
          name: `form:${name}`,
          kind: 'variable',
          byteStart: element.startIndex,
          byteEnd: element.endIndex,
          lineStart: element.startPosition.row + 1,
          lineEnd: element.endPosition.row + 1,
          metadata: { formElement: tagName, formName: name },
        });
      }
    }

    // --- IDs (any element) ---
    const id = getAttr(tag, 'id');
    if (id) {
      symbols.push({
        symbolId: `${filePath}::#${id}#variable`,
        name: `#${id}`,
        kind: 'variable',
        byteStart: tag.startIndex,
        byteEnd: tag.endIndex,
        lineStart: tag.startPosition.row + 1,
        lineEnd: tag.endPosition.row + 1,
        metadata: { htmlId: id },
      });
    }

    // --- Custom elements (tags with a hyphen) ---
    if (tagName.includes('-') && /^[a-z]/.test(tagName)) {
      if (!seenCustom.has(tagName)) {
        seenCustom.add(tagName);
        symbols.push({
          symbolId: `${filePath}::<${tagName}>#variable`,
          name: `<${tagName}>`,
          kind: 'variable',
          byteStart: tagNameNode.startIndex,
          byteEnd: tagNameNode.endIndex,
          lineStart: tagNameNode.startPosition.row + 1,
          lineEnd: tagNameNode.endPosition.row + 1,
          metadata: { customElement: true },
        });
      }
    }
  }
}
