/**
 * Span-to-Code Mapper — links runtime spans to static graph nodes.
 * Mapping strategies (priority order):
 * 1. code.function + code.namespace → symbol FQN
 * 2. code.filepath + code.lineno → enclosing symbol
 * 3. HTTP route pattern → route node
 * 4. Operation name heuristic → symbol name match
 */

import type { Store } from '../db/store.js';
import type { RuntimeSpanRow } from './types.js';
import { logger } from '../logger.js';

interface MappingConfig {
  fqnAttributes: string[];
  routePatterns: RegExp[];
}

const DEFAULT_CONFIG: MappingConfig = {
  fqnAttributes: ['code.function', 'code.namespace', 'code.filepath'],
  routePatterns: [/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/],
};

export class SpanMapper {
  private config: MappingConfig;

  constructor(
    private store: Store,
    config?: Partial<MappingConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Map all unmapped spans. Returns count of newly mapped spans. */
  mapUnmapped(limit = 500): number {
    const unmapped = this.store.db
      .prepare(`
      SELECT * FROM runtime_spans WHERE mapped_node_id IS NULL LIMIT ?
    `)
      .all(limit) as RuntimeSpanRow[];

    if (unmapped.length === 0) return 0;

    const updateStmt = this.store.db.prepare(
      'UPDATE runtime_spans SET mapped_node_id = ?, mapping_method = ? WHERE id = ?',
    );

    let mapped = 0;
    this.store.db.transaction(() => {
      for (const span of unmapped) {
        const result = this.mapSpan(span);
        if (result) {
          updateStmt.run(result.nodeId, result.method, span.id);
          mapped++;
        }
      }
    })();

    if (mapped > 0) {
      logger.debug({ mapped, total: unmapped.length }, 'Mapped runtime spans to code');
    }

    return mapped;
  }

  /** Map a single span. Returns the matched node_id or null. */
  mapSpan(span: RuntimeSpanRow): { nodeId: number; method: string } | null {
    let attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string } }> = [];
    if (span.attributes) {
      try {
        attrs = JSON.parse(span.attributes);
      } catch {
        /* corrupted attributes, skip */
      }
    }

    // Strategy 1: FQN from code.function + code.namespace
    const codeFunction = this.getAttr(attrs, 'code.function');
    const codeNamespace = this.getAttr(attrs, 'code.namespace');
    if (codeFunction) {
      const fqn = codeNamespace ? `${codeNamespace}.${codeFunction}` : codeFunction;
      const sym = this.store.getSymbolByFqn(fqn);
      if (sym) {
        const nodeId = this.store.getNodeId('symbol', sym.id);
        if (nodeId) return { nodeId, method: 'fqn' };
      }
      // Try just function name
      const symByName = this.store.getSymbolByName(codeFunction);
      if (symByName) {
        const nodeId = this.store.getNodeId('symbol', symByName.id);
        if (nodeId) return { nodeId, method: 'fqn' };
      }
    }

    // Strategy 2: code.filepath + code.lineno
    const codeFilepath = this.getAttr(attrs, 'code.filepath');
    const codeLineno = this.getAttr(attrs, 'code.lineno');
    if (codeFilepath) {
      const file = this.store.getFile(codeFilepath);
      if (file) {
        if (codeLineno) {
          const lineNum = parseInt(codeLineno, 10);
          // Find enclosing symbol
          const symbols = this.store.getSymbolsByFile(file.id);
          for (const sym of symbols) {
            if (
              sym.line_start &&
              sym.line_end &&
              lineNum >= sym.line_start &&
              lineNum <= sym.line_end
            ) {
              const nodeId = this.store.getNodeId('symbol', sym.id);
              if (nodeId) return { nodeId, method: 'file_line' };
            }
          }
        }
        // Fall back to file node
        const nodeId = this.store.getNodeId('file', file.id);
        if (nodeId) return { nodeId, method: 'file_line' };
      }
    }

    // Strategy 3: HTTP route pattern (for server spans)
    if (span.kind === 'server') {
      for (const pattern of this.config.routePatterns) {
        const match = pattern.exec(span.operation);
        if (match) {
          const uri = match[1];
          // Extract method from operation
          const methodMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/i.exec(span.operation);
          const method = methodMatch?.[1]?.toUpperCase();
          const route = this.store.findRouteByPattern(uri, method ?? '*');
          if (route) {
            const nodeId = this.store.getNodeId('route', route.id);
            if (nodeId) return { nodeId, method: 'route' };
          }
        }
      }
    }

    // Strategy 4: Operation name heuristic
    const opName = span.operation
      .replace(/^(Controller\.|Service\.|Handler\.)/, '')
      .replace(/\s+/g, '');
    if (opName.length > 2 && opName.length < 100) {
      const sym = this.store.getSymbolByName(opName);
      if (sym) {
        const nodeId = this.store.getNodeId('symbol', sym.id);
        if (nodeId) return { nodeId, method: 'heuristic' };
      }
    }

    return null;
  }

  private getAttr(
    attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>,
    key: string,
  ): string | undefined {
    const kv = attrs.find((a) => a.key === key);
    return kv?.value.stringValue ?? kv?.value.intValue;
  }
}
