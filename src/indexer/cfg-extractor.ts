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
  | 'merge'
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
  label?: 'true' | 'false' | 'exception' | 'default' | 'fallthrough' | 'back';
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
  // `do` must be a standalone loop keyword — optionally followed by `{` and
  // nothing else on the line. Anchoring the end prevents `doThing()`, `done()`,
  // `download(x)` and other do-prefixed identifiers from being mis-classified
  // as do-while loops (which injected phantom loop nodes + back-edges).
  { kind: 'do_while', regex: /^\s*do\s*\{?\s*$/ },
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

  // Loop kinds form cycles: their body loops back to the header, and the header
  // has a "false" exit edge to whatever follows the loop.
  const LOOP_KINDS = new Set<CFGNodeKind>(['for', 'while', 'do_while', 'for_of', 'for_in']);

  // Loop headers whose body just closed, awaiting the continuation node so we
  // can wire the header's loop-exit (false) edge to it.
  const pendingLoopExits: number[] = [];

  // Wire any pending loop-exit (false) edges to the next real node `targetId`,
  // then clear the queue. Called whenever control flow rejoins the linear
  // sequence after a loop body closes.
  const flushPendingLoopExits = (targetId: number): void => {
    if (pendingLoopExits.length === 0) return;
    for (const headerId of pendingLoopExits) {
      mkEdge(headerId, targetId, 'false');
    }
    pendingLoopExits.length = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = startLine + i;
    const trimmed = line.trim();

    // do-while tail: `} while (cond);` closes a do_while loop. The condition
    // sits AT THE BOTTOM, so the back-edge goes from this tail to the do header
    // and the exit edge leaves from here to the continuation.
    const doWhileTail = /^\}\s*while\s*\((.+?)\)\s*;?\s*$/.exec(trimmed);
    if (doWhileTail && nestingStack.length > 0 && nestingStack.at(-1)?.kind === 'do_while') {
      const popped = nestingStack.pop()!;
      currentNesting = Math.max(0, currentNesting - 1);
      const header = nodes.find((n) => n.id === popped.nodeId);
      if (header && !header.condition) header.condition = doWhileTail[1].trim().slice(0, 120);
      // Back-edge from the loop tail to the header (the cycle).
      mkEdge(prevNodeId, popped.nodeId, 'back');
      // Exit edge leaves the loop when the condition is false.
      pendingLoopExits.push(popped.nodeId);
      prevNodeId = popped.nodeId;
      continue;
    }

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
        const popped = nestingStack.pop()!;
        currentNesting = Math.max(0, currentNesting - 1);

        if (LOOP_KINDS.has(popped.kind)) {
          // Back-edge: the last node of the loop body loops back to the header.
          // Guard against the degenerate empty-body case (prev === header).
          if (prevNodeId !== popped.nodeId) {
            mkEdge(prevNodeId, popped.nodeId, 'back');
          } else {
            // Empty body still forms a self-cycle on the header.
            mkEdge(popped.nodeId, popped.nodeId, 'back');
          }
          // The header's "false" (condition-failed) edge leaves the loop; wire
          // it to whatever node comes next. After a back-edge the linear cursor
          // returns to the loop header so the exit edge originates correctly.
          pendingLoopExits.push(popped.nodeId);
          prevNodeId = popped.nodeId;
        } else if (popped.kind === 'try') {
          // The try/catch/finally chain just fully closed (bare `}` after the
          // last handler). Create a single merge node where all paths through
          // the construct rejoin, and route the current tail into it. Catch
          // nodes belonging to this try (declared between the try header and
          // this closing brace) are also wired into the merge so the exception
          // path converges instead of dangling.
          const tryHeader = nodes.find((n) => n.id === popped.nodeId);
          const merge = mkNode('merge', lineNum, 'merge');
          mkEdge(prevNodeId, merge.id);
          if (tryHeader) {
            for (const n of nodes) {
              if (n.kind === 'catch' && n.line > tryHeader.line && n.line < lineNum) {
                mkEdge(n.id, merge.id);
              }
            }
          }
          prevNodeId = merge.id;
        }
      }
      continue;
    }

    let matched = false;
    for (const pattern of PATTERNS) {
      const m = line.match(pattern.regex);
      if (!m) continue;

      const condition = pattern.condGroup ? m[pattern.condGroup] : undefined;
      const node = mkNode(pattern.kind, lineNum, trimmed, condition);

      // A loop that just closed has its exit (condition-false) edge wired to
      // this next node — unless this node continues the same chain (e.g. an
      // else/catch/finally that conceptually belongs to the prior construct).
      if (pattern.kind !== 'else' && pattern.kind !== 'catch' && pattern.kind !== 'finally') {
        flushPendingLoopExits(node.id);
      }

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
        // Collapse consecutive straight-line statements into one node — but
        // ONLY when the last emitted statement is the current linear
        // predecessor. Checking `nodes[nodes.length - 1]` (array order) alone
        // is wrong: after a nested block closes, control flow rejoins at the
        // loop header / merge node and `prevNodeId` is reset there, while the
        // last-created node is still the buried inner-body statement. Collapsing
        // against that absorbs the post-block statement (e.g. `afterInner()`)
        // into a node it doesn't actually follow. Requiring
        // `prevNode.id === prevNodeId` keeps genuine sequences collapsed while
        // emitting a fresh node whenever control flow has rejoined.
        const prevNode = nodes[nodes.length - 1];
        if (prevNode && prevNode.kind === 'statement' && prevNode.id === prevNodeId) {
          // Don't create a new node, just update snippet
          continue;
        }
        const node = mkNode('statement', lineNum, trimmed);
        flushPendingLoopExits(node.id);
        mkEdge(prevNodeId, node.id);
        prevNodeId = node.id;
      }
    }
  }

  // Exit node
  const exit = mkNode('exit', startLine + lines.length - 1, 'Exit');
  // Any loop whose exit edge never found a continuation (loop is the last
  // construct in the function) leaves the loop straight to exit.
  flushPendingLoopExits(exit.id);
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
