/**
 * Control Flow Graph (CFG) extractor.
 *
 * Builds a CFG from function source code by parsing control flow statements.
 * Phase 1: TypeScript/JavaScript via regex-based heuristic parsing.
 *
 * No external parser dependency — uses line-by-line pattern matching
 * on the source code to identify control flow nodes and edges.
 */

type CFGNodeKind =
  | 'entry'
  | 'exit'
  | 'if'
  | 'else'
  | 'else_if'
  | 'for'
  | 'while'
  | 'do_while'
  | 'for_of'
  | 'for_in'
  | 'switch'
  | 'case'
  | 'default'
  | 'try'
  | 'catch'
  | 'finally'
  | 'return'
  | 'throw'
  | 'break'
  | 'continue'
  | 'await'
  | 'yield'
  | 'statement';

interface CFGNode {
  id: number;
  kind: CFGNodeKind;
  line: number;
  code_snippet: string;
  condition?: string;
}

interface CFGEdge {
  from: number;
  to: number;
  label?: 'true' | 'false' | 'exception' | 'default' | 'fallthrough';
}

export interface CFGResult {
  nodes: CFGNode[];
  edges: CFGEdge[];
  cyclomatic_complexity: number;
  paths: number;
  max_nesting: number;
}

/** Patterns for control flow statements (JS/TS + Python) */
const PATTERNS: { kind: CFGNodeKind; regex: RegExp; condGroup?: number }[] = [
  // --- JS/TS patterns ---
  { kind: 'else_if', regex: /^\s*}\s*else\s+if\s*\((.+?)\)\s*\{?/, condGroup: 1 },
  { kind: 'else', regex: /^\s*}\s*else\s*\{?/ },
  { kind: 'if', regex: /^\s*(?:}\s*)?if\s*\((.+?)\)\s*\{?/, condGroup: 1 },
  {
    kind: 'for_of',
    regex: /^\s*for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+(.+?)\)\s*\{?/,
    condGroup: 1,
  },
  {
    kind: 'for_in',
    regex: /^\s*for\s*\(\s*(?:const|let|var)\s+\w+\s+in\s+(.+?)\)\s*\{?/,
    condGroup: 1,
  },
  { kind: 'for', regex: /^\s*for\s*\((.+?)\)\s*\{?/, condGroup: 1 },
  { kind: 'while', regex: /^\s*while\s*\((.+?)\)\s*\{?/, condGroup: 1 },
  { kind: 'do_while', regex: /^\s*do\s*\{?/ },
  { kind: 'switch', regex: /^\s*switch\s*\((.+?)\)\s*\{?/, condGroup: 1 },
  { kind: 'case', regex: /^\s*case\s+(.+?)\s*:/, condGroup: 1 },
  { kind: 'default', regex: /^\s*default\s*:/ },
  { kind: 'try', regex: /^\s*try\s*\{/ },
  { kind: 'catch', regex: /^\s*}\s*catch\s*(?:\((.+?)\))?\s*\{?/, condGroup: 1 },
  { kind: 'finally', regex: /^\s*}\s*finally\s*\{/ },
  { kind: 'return', regex: /^\s*return\b/ },
  { kind: 'throw', regex: /^\s*throw\b/ },
  { kind: 'break', regex: /^\s*break\b/ },
  { kind: 'continue', regex: /^\s*continue\b/ },
  { kind: 'await', regex: /^\s*(?:const|let|var)?\s*\w*\s*=?\s*await\b/ },
  { kind: 'yield', regex: /^\s*(?:const|let|var)?\s*\w*\s*=?\s*yield\b/ },

  // --- Python patterns ---
  // Python: elif condition:
  { kind: 'else_if', regex: /^\s*elif\s+(.+?)\s*:/, condGroup: 1 },
  // Python: else: (no brace, colon-terminated)
  { kind: 'else', regex: /^\s*else\s*:/ },
  // Python: if condition:
  { kind: 'if', regex: /^\s*if\s+(.+?)\s*:/, condGroup: 1 },
  // Python: for x in iterable:
  {
    kind: 'for_in',
    regex: /^\s*(?:async\s+)?for\s+\w+(?:\s*,\s*\w+)*\s+in\s+(.+?)\s*:/,
    condGroup: 1,
  },
  // Python: while condition:
  { kind: 'while', regex: /^\s*while\s+(.+?)\s*:/, condGroup: 1 },
  // Python: match subject:  (3.10+)
  { kind: 'switch', regex: /^\s*match\s+(.+?)\s*:/, condGroup: 1 },
  // Python: case pattern:
  { kind: 'case', regex: /^\s*case\s+(.+?)\s*:/, condGroup: 1 },
  // Python: try:
  { kind: 'try', regex: /^\s*try\s*:/ },
  // Python: except ExceptionType as e:
  { kind: 'catch', regex: /^\s*except\s*(.+?)?\s*:/, condGroup: 1 },
  // Python: finally:
  { kind: 'finally', regex: /^\s*finally\s*:/ },
  // Python: raise
  { kind: 'throw', regex: /^\s*raise\b/ },
  // Python: with ... as ...: (context manager = resource acquisition)
  { kind: 'try', regex: /^\s*(?:async\s+)?with\s+(.+?)\s*:/, condGroup: 1 },
  // Python: yield / yield from
  { kind: 'yield', regex: /^\s*yield\b/ },
  // Python: await
  { kind: 'await', regex: /^\s*\w+\s*=\s*await\b/ },
];

export function extractCFG(source: string, startLine = 1): CFGResult {
  const lines = source.split('\n');
  const nodes: CFGNode[] = [];
  const edges: CFGEdge[] = [];
  let nextId = 0;

  const mkNode = (
    kind: CFGNodeKind,
    line: number,
    snippet: string,
    condition?: string,
  ): CFGNode => {
    const node: CFGNode = { id: nextId++, kind, line, code_snippet: snippet.trim().slice(0, 80) };
    if (condition) node.condition = condition.trim().slice(0, 120);
    nodes.push(node);
    return node;
  };

  const mkEdge = (from: number, to: number, label?: CFGEdge['label']): void => {
    edges.push({ from, to, ...(label ? { label } : {}) });
  };

  // Entry node
  const entry = mkNode('entry', startLine, 'Entry');

  // Parse lines
  let prevNodeId = entry.id;
  let maxNesting = 0;
  let currentNesting = 0;
  const nestingStack: { kind: CFGNodeKind; nodeId: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = startLine + i;
    const trimmed = line.trim();

    if (
      !trimmed ||
      trimmed === '{' ||
      trimmed === '}' ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      // Track nesting on closing braces
      if (trimmed === '}' && nestingStack.length > 0) {
        nestingStack.pop();
        currentNesting = Math.max(0, currentNesting - 1);
      }
      continue;
    }

    let matched = false;
    for (const pattern of PATTERNS) {
      const m = line.match(pattern.regex);
      if (!m) continue;

      const condition = pattern.condGroup ? m[pattern.condGroup] : undefined;
      const node = mkNode(pattern.kind, lineNum, trimmed, condition);

      // Branching logic
      switch (pattern.kind) {
        case 'if':
        case 'else_if':
          mkEdge(prevNodeId, node.id, 'true');
          currentNesting++;
          maxNesting = Math.max(maxNesting, currentNesting);
          nestingStack.push({ kind: pattern.kind, nodeId: node.id });
          break;

        case 'else':
          // Edge from the preceding if/else_if's false branch
          if (nestingStack.length > 0) {
            const prev = nestingStack[nestingStack.length - 1];
            mkEdge(prev.nodeId, node.id, 'false');
          } else {
            mkEdge(prevNodeId, node.id);
          }
          break;

        case 'for':
        case 'for_of':
        case 'for_in':
        case 'while':
        case 'do_while':
          mkEdge(prevNodeId, node.id);
          currentNesting++;
          maxNesting = Math.max(maxNesting, currentNesting);
          nestingStack.push({ kind: pattern.kind, nodeId: node.id });
          break;

        case 'switch':
          mkEdge(prevNodeId, node.id);
          currentNesting++;
          maxNesting = Math.max(maxNesting, currentNesting);
          nestingStack.push({ kind: 'switch', nodeId: node.id });
          break;

        case 'case':
        case 'default': {
          // Link from switch node
          const switchCtx = nestingStack.findLast((s) => s.kind === 'switch');
          if (switchCtx) {
            mkEdge(switchCtx.nodeId, node.id, pattern.kind === 'default' ? 'default' : undefined);
          } else {
            mkEdge(prevNodeId, node.id);
          }
          break;
        }

        case 'try':
          mkEdge(prevNodeId, node.id);
          currentNesting++;
          maxNesting = Math.max(maxNesting, currentNesting);
          nestingStack.push({ kind: 'try', nodeId: node.id });
          break;

        case 'catch':
          // Link from try's exception path
          if (nestingStack.length > 0) {
            const tryCtx = nestingStack.findLast((s) => s.kind === 'try');
            if (tryCtx) {
              mkEdge(tryCtx.nodeId, node.id, 'exception');
            }
          }
          mkEdge(prevNodeId, node.id);
          break;

        case 'finally':
          mkEdge(prevNodeId, node.id);
          break;

        case 'return':
        case 'throw':
          mkEdge(prevNodeId, node.id);
          break;

        case 'break':
        case 'continue':
          mkEdge(prevNodeId, node.id);
          break;

        default:
          mkEdge(prevNodeId, node.id);
      }

      prevNodeId = node.id;
      matched = true;
      break;
    }

    if (!matched && trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      // Regular statement — only create node if it looks meaningful
      if (trimmed.includes('(') || trimmed.includes('=') || trimmed.includes('.')) {
        // Collapse sequential statements in simplify mode
        const prevNode = nodes[nodes.length - 1];
        if (prevNode && prevNode.kind === 'statement') {
          // Don't create a new node, just update snippet
          continue;
        }
        const node = mkNode('statement', lineNum, trimmed);
        mkEdge(prevNodeId, node.id);
        prevNodeId = node.id;
      }
    }
  }

  // Exit node
  const exit = mkNode('exit', startLine + lines.length - 1, 'Exit');
  mkEdge(prevNodeId, exit.id);

  // Also link return/throw nodes to exit
  for (const node of nodes) {
    if (node.kind === 'return' || node.kind === 'throw') {
      mkEdge(node.id, exit.id);
    }
  }

  // Cyclomatic complexity = E - N + 2P (P=1 for single component)
  const cyclomaticComplexity = edges.length - nodes.length + 2;

  // Estimate paths (simplified: count decision nodes + 1)
  const decisionNodes = nodes.filter((n) =>
    ['if', 'else_if', 'for', 'while', 'case', 'catch'].includes(n.kind),
  );
  const paths = decisionNodes.length + 1;

  return {
    nodes,
    edges,
    cyclomatic_complexity: Math.max(1, cyclomaticComplexity),
    paths,
    max_nesting: maxNesting,
  };
}

/** Render CFG as Mermaid flowchart */
export function cfgToMermaid(cfg: CFGResult): string {
  const lines: string[] = ['flowchart TD'];

  for (const node of cfg.nodes) {
    const label = node.condition ? `${node.condition}` : node.code_snippet;
    const escaped = label.replace(/"/g, "'").replace(/[[\]{}]/g, '');

    switch (node.kind) {
      case 'entry':
      case 'exit':
        lines.push(`    N${node.id}([${escaped}])`);
        break;
      case 'if':
      case 'else_if':
      case 'while':
      case 'for':
      case 'for_of':
      case 'for_in':
        lines.push(`    N${node.id}{${escaped}}`);
        break;
      case 'switch':
        lines.push(`    N${node.id}{${escaped}}`);
        break;
      default:
        lines.push(`    N${node.id}[${escaped}]`);
    }
  }

  for (const edge of cfg.edges) {
    if (edge.label) {
      lines.push(`    N${edge.from} -->|${edge.label}| N${edge.to}`);
    } else {
      lines.push(`    N${edge.from} --> N${edge.to}`);
    }
  }

  return lines.join('\n');
}

/** Render CFG as ASCII art (simplified) */
export function cfgToAscii(cfg: CFGResult): string {
  const lines: string[] = [];
  for (const node of cfg.nodes) {
    const prefix =
      node.kind === 'entry' || node.kind === 'exit'
        ? `[${node.kind.toUpperCase()}]`
        : `  ${node.kind}`;
    const cond = node.condition ? ` (${node.condition})` : '';
    lines.push(`${prefix} L${node.line}: ${node.code_snippet}${cond}`);

    // Show outgoing edges
    const outEdges = cfg.edges.filter((e) => e.from === node.id);
    for (const e of outEdges) {
      const target = cfg.nodes.find((n) => n.id === e.to);
      if (target) {
        const label = e.label ? ` [${e.label}]` : '';
        lines.push(`    └→ ${target.kind} L${target.line}${label}`);
      }
    }
  }
  return lines.join('\n');
}
