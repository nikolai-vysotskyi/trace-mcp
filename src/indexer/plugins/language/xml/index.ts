/**
 * XML Language Plugin — dialect-aware symbol extraction.
 *
 * Detects XML dialect from root element / namespace / filename and applies
 * specialised extraction rules for:
 *   - XSD / WSDL / XSLT / XUL
 *   - RSS / Atom feeds
 *   - Sitemaps
 *   - Maven POM
 *   - .csproj / .fsproj / .vbproj (.NET project files)
 *   - Android manifests
 *   - Spring applicationContext
 *   - Java web.xml / struts / Hibernate / log4j / logback
 *   - Ant build.xml
 *   - Apple .plist
 *   - SVG
 *   - Generic XML (id / name fallback)
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function symId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

interface Tag {
  tag: string;      // full tag name (e.g. "xs:element")
  local: string;    // local part (e.g. "element")
  attrs: string;    // raw attribute string
  offset: number;   // byte offset of '<'
}

/** O(n) tag scanner — no regex backtracking. */
function* scanTags(source: string): Generator<Tag> {
  let pos = 0;
  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt === -1) break;
    const next = source[lt + 1];
    if (!next || next === '/' || next === '!' || next === '?') { pos = lt + 2; continue; }
    const gt = source.indexOf('>', lt + 1);
    if (gt === -1) break;
    const content = source.slice(lt + 1, gt);
    const nm = content.match(/^([a-zA-Z_][\w:.-]*)/);
    if (nm) {
      const full = nm[1];
      const colon = full.lastIndexOf(':');
      yield { tag: full, local: colon >= 0 ? full.slice(colon + 1) : full, attrs: content.slice(nm[0].length), offset: lt };
    }
    pos = gt + 1;
  }
}

function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** Get text content between <tag>...text...</tag> — simplified, returns first text run. */
function getTextContent(source: string, offset: number): string | undefined {
  const gt = source.indexOf('>', offset);
  if (gt === -1) return undefined;
  const lt = source.indexOf('<', gt + 1);
  if (lt === -1) return undefined;
  const text = source.slice(gt + 1, lt).trim();
  return text || undefined;
}

// ── Dialect detection ──────────────────────────────────────────────────────

type XmlDialect =
  | 'xsd' | 'wsdl' | 'xslt' | 'xul'
  | 'rss' | 'atom'
  | 'sitemap'
  | 'maven-pom' | 'maven-settings'
  | 'dotnet-project'
  | 'android-manifest'
  | 'spring-beans' | 'web-xml' | 'struts' | 'hibernate' | 'logback' | 'log4j'
  | 'ant-build'
  | 'plist'
  | 'svg'
  | 'docbook'
  | 'generic';

function detectDialect(filePath: string, rootTag: string, rootAttrs: string): XmlDialect {
  const lower = rootTag.toLowerCase();
  const localRoot = rootTag.includes(':') ? rootTag.split(':').pop()!.toLowerCase() : lower;
  const fn = filePath.toLowerCase();

  // Filename-based detection (highest priority)
  if (fn.endsWith('.xsd')) return 'xsd';
  if (fn.endsWith('.wsdl')) return 'wsdl';
  if (fn.endsWith('.xsl') || fn.endsWith('.xslt')) return 'xslt';
  if (fn.endsWith('.xul')) return 'xul';
  if (fn.endsWith('.svg')) return 'svg';
  if (fn.endsWith('.plist')) return 'plist';
  if (fn.endsWith('.csproj') || fn.endsWith('.fsproj') || fn.endsWith('.vbproj') || fn.endsWith('.props') || fn.endsWith('.targets')) return 'dotnet-project';
  if (fn.endsWith('pom.xml') || fn.includes('/pom.xml')) return 'maven-pom';
  if (fn.endsWith('build.xml')) return 'ant-build';
  if (fn.endsWith('web.xml')) return 'web-xml';
  if (fn.endsWith('struts.xml') || fn.endsWith('struts-config.xml')) return 'struts';
  if (fn.endsWith('androidmanifest.xml') || fn.includes('androidmanifest')) return 'android-manifest';
  if (fn.endsWith('logback.xml')) return 'logback';
  if (fn.endsWith('log4j.xml') || fn.endsWith('log4j2.xml')) return 'log4j';
  if (fn.endsWith('hibernate.cfg.xml') || fn.includes('hibernate')) return 'hibernate';
  if (fn.endsWith('settings.xml') && rootAttrs.includes('maven')) return 'maven-settings';

  // Root element detection
  if (localRoot === 'schema' && rootAttrs.includes('XMLSchema')) return 'xsd';
  if (localRoot === 'definitions' && rootAttrs.includes('wsdl')) return 'wsdl';
  if (localRoot === 'stylesheet' || localRoot === 'transform') return 'xslt';
  if (lower === 'rss') return 'rss';
  if (localRoot === 'feed' && rootAttrs.includes('Atom')) return 'atom';
  if (localRoot === 'urlset' || localRoot === 'sitemapindex') return 'sitemap';
  if (localRoot === 'project' && rootAttrs.includes('maven')) return 'maven-pom';
  if (localRoot === 'project' && rootAttrs.includes('ant')) return 'ant-build';
  if (localRoot === 'manifest' && rootAttrs.includes('android')) return 'android-manifest';
  if (localRoot === 'beans' || (localRoot === 'beans' && rootAttrs.includes('springframework'))) return 'spring-beans';
  if (lower === 'svg') return 'svg';
  if (localRoot === 'plist') return 'plist';
  if (localRoot === 'book' || localRoot === 'article') return 'docbook';
  if (localRoot === 'window' || localRoot === 'dialog' || localRoot === 'overlay') return 'xul';
  if (localRoot === 'configuration' && rootAttrs.includes('log4j')) return 'log4j';
  if (localRoot === 'configuration' && rootAttrs.includes('logback')) return 'logback';
  if (localRoot === 'project' && (rootAttrs.includes('Sdk=') || rootAttrs.includes('ToolsVersion'))) return 'dotnet-project';

  return 'generic';
}

// ── Dialect-specific tag rules ─────────────────────────────────────────────

interface TagRule {
  /** Tag local names to match. '*' = any tag. */
  tags: Set<string> | '*';
  /** Which attribute to extract as symbol name. */
  attr: string;
  /** Symbol kind. */
  kind: SymbolKind;
  /** xmlKind metadata value. */
  xmlKind: string;
  /** Attribute for text content extraction instead of attr (e.g. plist <key>). */
  textContent?: boolean;
}

function getDialectRules(dialect: XmlDialect): TagRule[] {
  switch (dialect) {
    case 'xsd':
      return [
        { tags: new Set(['complextype', 'simpletype', 'element', 'attribute', 'attributegroup', 'group']), attr: 'name', kind: 'type', xmlKind: 'schemaType' },
      ];
    case 'wsdl':
      return [
        { tags: new Set(['message', 'porttype', 'binding', 'service']), attr: 'name', kind: 'type', xmlKind: 'wsdl' },
        { tags: new Set(['operation']), attr: 'name', kind: 'function', xmlKind: 'wsdl' },
        { tags: new Set(['part']), attr: 'name', kind: 'property', xmlKind: 'wsdl' },
      ];
    case 'xslt':
      return [
        { tags: new Set(['template']), attr: 'name', kind: 'function', xmlKind: 'xslt' },
        { tags: new Set(['variable', 'param']), attr: 'name', kind: 'variable', xmlKind: 'xslt' },
        { tags: new Set(['key', 'function']), attr: 'name', kind: 'function', xmlKind: 'xslt' },
        { tags: new Set(['output']), attr: 'method', kind: 'constant', xmlKind: 'xslt' },
      ];
    case 'rss':
      return [
        { tags: new Set(['channel']), attr: '__text_title', kind: 'namespace', xmlKind: 'rss' },
        { tags: new Set(['item']), attr: '__text_title', kind: 'constant', xmlKind: 'rssItem' },
        { tags: new Set(['category']), attr: '__text', kind: 'constant', xmlKind: 'rssCategory' },
      ];
    case 'atom':
      return [
        { tags: new Set(['entry']), attr: '__text_title', kind: 'constant', xmlKind: 'atomEntry' },
      ];
    case 'sitemap':
      return [
        { tags: new Set(['loc']), attr: '__text', kind: 'constant', xmlKind: 'url' },
        { tags: new Set(['sitemap']), attr: '__text_loc', kind: 'constant', xmlKind: 'sitemapRef' },
      ];
    case 'maven-pom':
      return [
        { tags: new Set(['groupid']), attr: '__text', kind: 'namespace', xmlKind: 'mavenGroup' },
        { tags: new Set(['artifactid']), attr: '__text', kind: 'constant', xmlKind: 'mavenArtifact' },
        { tags: new Set(['plugin']), attr: '__child_artifactid', kind: 'constant', xmlKind: 'mavenPlugin' },
      ];
    case 'dotnet-project':
      return [
        { tags: new Set(['packagereference']), attr: 'Include', kind: 'constant', xmlKind: 'nuget' },
        { tags: new Set(['projectreference']), attr: 'Include', kind: 'constant', xmlKind: 'projectRef' },
        { tags: new Set(['compile', 'content', 'none', 'embeddedresource']), attr: 'Include', kind: 'constant', xmlKind: 'msbuildItem' },
      ];
    case 'android-manifest':
      return [
        { tags: new Set(['activity', 'service', 'receiver', 'provider']), attr: 'android:name', kind: 'class', xmlKind: 'android' },
        { tags: new Set(['permission', 'uses-permission']), attr: 'android:name', kind: 'constant', xmlKind: 'androidPermission' },
        { tags: new Set(['intent-filter']), attr: '__skip', kind: 'constant', xmlKind: '' },
        { tags: new Set(['action']), attr: 'android:name', kind: 'constant', xmlKind: 'androidAction' },
      ];
    case 'spring-beans':
      return [
        { tags: new Set(['bean']), attr: 'id', kind: 'class', xmlKind: 'springBean' },
        { tags: new Set(['bean']), attr: 'class', kind: 'type', xmlKind: 'springBeanClass' },
        { tags: new Set(['property']), attr: 'name', kind: 'property', xmlKind: 'springProperty' },
        { tags: new Set(['alias']), attr: 'name', kind: 'constant', xmlKind: 'springAlias' },
      ];
    case 'web-xml':
      return [
        { tags: new Set(['servlet-name', 'filter-name', 'listener']), attr: '__text', kind: 'class', xmlKind: 'webXml' },
        { tags: new Set(['servlet-class', 'filter-class', 'listener-class']), attr: '__text', kind: 'type', xmlKind: 'webXmlClass' },
        { tags: new Set(['url-pattern']), attr: '__text', kind: 'constant', xmlKind: 'urlPattern' },
      ];
    case 'struts':
      return [
        { tags: new Set(['action']), attr: 'name', kind: 'function', xmlKind: 'strutsAction' },
        { tags: new Set(['result']), attr: 'name', kind: 'constant', xmlKind: 'strutsResult' },
        { tags: new Set(['package']), attr: 'name', kind: 'namespace', xmlKind: 'strutsPackage' },
      ];
    case 'hibernate':
      return [
        { tags: new Set(['class']), attr: 'name', kind: 'class', xmlKind: 'hibernateClass' },
        { tags: new Set(['property', 'id', 'set', 'bag', 'list', 'map']), attr: 'name', kind: 'property', xmlKind: 'hibernateProperty' },
      ];
    case 'logback':
    case 'log4j':
      return [
        { tags: new Set(['appender']), attr: 'name', kind: 'constant', xmlKind: 'logAppender' },
        { tags: new Set(['logger']), attr: 'name', kind: 'constant', xmlKind: 'logLogger' },
        { tags: new Set(['root']), attr: 'level', kind: 'constant', xmlKind: 'logRootLevel' },
      ];
    case 'ant-build':
      return [
        { tags: new Set(['target']), attr: 'name', kind: 'function', xmlKind: 'antTarget' },
        { tags: new Set(['property']), attr: 'name', kind: 'variable', xmlKind: 'antProperty' },
        { tags: new Set(['path', 'fileset', 'patternset']), attr: 'id', kind: 'constant', xmlKind: 'antRef' },
        { tags: new Set(['macrodef', 'taskdef']), attr: 'name', kind: 'function', xmlKind: 'antMacro' },
      ];
    case 'plist':
      return [
        { tags: new Set(['key']), attr: '__text', kind: 'property', xmlKind: 'plistKey' },
      ];
    case 'svg':
      return [
        { tags: new Set(['lineargradient', 'radialgradient', 'clippath', 'mask', 'pattern', 'symbol', 'marker']), attr: 'id', kind: 'constant', xmlKind: 'svgDef' },
        { tags: new Set(['g', 'rect', 'circle', 'path', 'text', 'image', 'use']), attr: 'id', kind: 'constant', xmlKind: 'svgElement' },
      ];
    case 'xul':
      return [
        { tags: new Set(['command', 'key', 'broadcaster']), attr: 'id', kind: 'constant', xmlKind: 'xul' },
        { tags: new Set(['menuitem', 'toolbarbutton', 'button']), attr: 'id', kind: 'constant', xmlKind: 'xulWidget' },
      ];
    case 'docbook':
      return [
        { tags: new Set(['chapter', 'section', 'appendix', 'part']), attr: 'id', kind: 'namespace', xmlKind: 'docbookSection' },
      ];
    default:
      return [];
  }
}

/** Import-worthy tags per dialect. */
function getImportTags(dialect: XmlDialect): Set<string> {
  const base = new Set(['import', 'include']);
  switch (dialect) {
    case 'dotnet-project':
      base.add('packagereference');
      base.add('projectreference');
      return base;
    case 'maven-pom':
      base.add('dependency');
      base.add('parent');
      return base;
    default:
      return base;
  }
}

// ── Main plugin ────────────────────────────────────────────────────────────

export class XmlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'xml-language',
    version: '2.0.0',
    priority: 8,
  };

  supportedExtensions = [
    '.xml', '.xul', '.xsl', '.xslt', '.xsd', '.wsdl', '.svg', '.plist',
    '.csproj', '.fsproj', '.vbproj', '.props', '.targets',
  ];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    const seen = new Set<string>();

    const add = (name: string, kind: SymbolKind, offset: number, meta?: Record<string, unknown>) => {
      if (!name) return;
      const id = symId(filePath, name, kind);
      if (seen.has(id)) return;
      seen.add(id);
      symbols.push({
        symbolId: id, name, kind, fqn: name,
        byteStart: offset, byteEnd: offset + name.length,
        lineStart: lineAt(source, offset), lineEnd: lineAt(source, offset),
        metadata: meta,
      });
    };

    let isFirstTag = true;
    let dialect: XmlDialect = 'generic';
    let dialectRules: TagRule[] = [];
    let importTags = new Set(['import', 'include']);

    // Noise tags whose `name` attribute is NOT structural
    const nameNoise = new Set(['input', 'meta', 'param', 'option', 'select', 'textarea', 'button', 'form', 'a', 'img']);

    // Track parent tags for RSS/Atom/Sitemap text content extraction
    let pendingTextTag: { local: string; offset: number } | null = null;
    let insideRssItem = false;
    let insideAtomEntry = false;

    for (const { tag, local, attrs, offset } of scanTags(source)) {
      const ll = local.toLowerCase();

      // ── Root element → detect dialect ──
      if (isFirstTag) {
        add(tag, 'type', offset, { xmlKind: 'rootElement' });
        dialect = detectDialect(filePath, tag, attrs);
        dialectRules = getDialectRules(dialect);
        importTags = getImportTags(dialect);
        isFirstTag = false;
      }

      // ── Dialect-specific rules ──
      for (const rule of dialectRules) {
        if (rule.tags !== '*' && !rule.tags.has(ll)) continue;

        if (rule.attr === '__text') {
          // Text content of this tag
          const text = getTextContent(source, offset);
          if (text) add(text, rule.kind, offset, { xmlKind: rule.xmlKind, tag });
          continue;
        }

        if (rule.attr === '__text_title') {
          // We need to find <title> child — mark for next iteration
          if (ll === 'item') insideRssItem = true;
          if (ll === 'entry') insideAtomEntry = true;
          continue;
        }

        if (rule.attr === '__text_loc') {
          // sitemap: <sitemap><loc>URL</loc></sitemap>
          continue; // handled by loc rule
        }

        if (rule.attr === '__child_artifactid') continue; // complex, skip
        if (rule.attr === '__skip') continue;

        const val = getAttr(attrs, rule.attr);
        if (val) add(val, rule.kind, offset, { xmlKind: rule.xmlKind, tag });
      }

      // RSS <title> inside <item> or <channel>
      if ((dialect === 'rss') && ll === 'title') {
        const text = getTextContent(source, offset);
        if (text) {
          if (insideRssItem) {
            add(text, 'constant', offset, { xmlKind: 'rssItem', tag });
          } else {
            add(text, 'namespace', offset, { xmlKind: 'rssFeed', tag });
          }
        }
      }
      if (dialect === 'rss' && ll === 'item') insideRssItem = true;
      // Rough tracking: when we see the next <item> or </channel>, reset
      if (dialect === 'rss' && (ll === 'channel' || ll === 'item')) insideRssItem = (ll === 'item');

      // Atom <title> inside <entry>
      if ((dialect === 'atom') && ll === 'title') {
        const text = getTextContent(source, offset);
        if (text) add(text, 'constant', offset, { xmlKind: 'atomEntry', tag });
      }

      // Sitemap <loc>
      if (dialect === 'sitemap' && ll === 'loc') {
        const text = getTextContent(source, offset);
        if (text) add(text, 'constant', offset, { xmlKind: 'url', tag });
      }

      // ── Generic: id attribute ──
      const idVal = getAttr(attrs, 'id');
      if (idVal) add(idVal, 'constant', offset, { xmlKind: 'idElement', tag });

      // ── Generic: name attribute (filtered) ──
      if (dialectRules.length === 0) {
        // Only apply generic name extraction when no dialect rules handle `name`
        const nameVal = getAttr(attrs, 'name');
        if (nameVal && !nameNoise.has(ll)) {
          add(nameVal, 'constant', offset, { xmlKind: 'namedElement', tag });
        }
      }

      // ── Namespace declarations ──
      const nsRe = /xmlns:(\w+)\s*=\s*["']/g;
      let nsm: RegExpExecArray | null;
      while ((nsm = nsRe.exec(attrs)) !== null) {
        add(nsm[1], 'namespace', offset);
      }

      // ── Import edges ──
      // Note: use `from` (not `module`) — file-extractor classifies import
      // edges by reading `metadata.from`. Without it, these edges get empty
      // paths and the resolver drops them, leaving XML/SVG files isolated.
      const href = getAttr(attrs, 'href');
      if (href && importTags.has(ll)) {
        edges.push({ edgeType: 'imports', metadata: { from: href, tag, dialect } });
      }

      // .NET PackageReference / ProjectReference
      if (dialect === 'dotnet-project' && (ll === 'packagereference' || ll === 'projectreference')) {
        const inc = getAttr(attrs, 'Include');
        if (inc) edges.push({ edgeType: 'imports', metadata: { from: inc, tag, dialect } });
      }

      // Maven dependency
      if (dialect === 'maven-pom' && ll === 'dependency') {
        // Dependency will have child <groupId>/<artifactId> — hard to get from tag scanner
        // At least record that this is a dependency section
      }

      // schemaLocation
      const schemaLoc = getAttr(attrs, 'schemaLocation');
      if (schemaLoc) {
        for (const p of schemaLoc.trim().split(/\s+/)) {
          if (p.endsWith('.xsd') || p.endsWith('.wsdl') || p.startsWith('http')) {
            edges.push({ edgeType: 'imports', metadata: { from: p, tag } });
          }
        }
      }

      // script src
      if (ll === 'script') {
        const src = getAttr(attrs, 'src');
        if (src) edges.push({ edgeType: 'imports', metadata: { from: src, tag: 'script' } });
      }

      // link[rel=stylesheet] href
      if (ll === 'link') {
        const rel = getAttr(attrs, 'rel');
        if (rel === 'stylesheet' && href) {
          edges.push({ edgeType: 'imports', metadata: { from: href, tag: 'link' } });
        }
      }

      // SVG <use href="sprite.svg#id"> / xlink:href
      if (dialect === 'svg' && ll === 'use') {
        const useHref = href ?? getAttr(attrs, 'xlink:href');
        if (useHref) {
          // Strip fragment (`sprite.svg#icon` → `sprite.svg`). A bare `#id`
          // references the current document — not an external edge.
          const hashIdx = useHref.indexOf('#');
          const target = hashIdx < 0 ? useHref : useHref.slice(0, hashIdx);
          if (target) edges.push({ edgeType: 'imports', metadata: { from: target, tag: 'use', dialect } });
        }
      }
      // SVG <image href="...">
      if (dialect === 'svg' && ll === 'image') {
        const imgHref = href ?? getAttr(attrs, 'xlink:href');
        if (imgHref) edges.push({ edgeType: 'imports', metadata: { from: imgHref, tag: 'image', dialect } });
      }
    }

    return ok({
      language: 'xml',
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
      metadata: dialect !== 'generic' ? { xmlDialect: dialect } : undefined,
    });
  }
}
