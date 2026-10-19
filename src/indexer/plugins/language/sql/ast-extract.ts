import type { Node } from 'web-tree-sitter';

export interface ExtractedCte {
  name: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
  /** Other CTE names referenced in FROM/JOIN (same file). */
  referencesCtes: string[];
  /** Disambiguates repeated CTE names in one file (symbol id suffix). */
  defIndex: number;
}

export interface ExtractedRelationRef {
  text: string;
  lineStart: number;
}

function lineStartOf(node: Node): number {
  return node.startPosition.row + 1;
}

function lineEndOf(node: Node): number {
  return node.endPosition.row + 1;
}

export function extractCtesFromTree(root: Node): ExtractedCte[] {
  const out: ExtractedCte[] = [];
  const nameCounts = new Map<string, number>();

  const walk = (node: Node) => {
    if (node.type === 'cte') {
      const id = node.children.find((c) => c.type === 'identifier');
      if (id) {
        const prev = nameCounts.get(id.text) ?? 0;
        const defIndex = prev;
        nameCounts.set(id.text, prev + 1);
        out.push({
          name: id.text,
          lineStart: lineStartOf(id),
          lineEnd: lineEndOf(node),
          byteStart: id.startIndex,
          byteEnd: node.endIndex,
          referencesCtes: [],
          defIndex,
        });
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  attachCteReferences(root, out);
  return out;
}

function attachCteReferences(root: Node, ctes: ExtractedCte[]): void {
  if (ctes.length === 0) return;
  const names = new Set(ctes.map((c) => c.name));
  const cteNodes: Node[] = [];

  const walk = (node: Node) => {
    if (node.type === 'cte') {
      const id = node.children.find((c) => c.type === 'identifier');
      if (id) cteNodes.push(node);
    }
    for (const child of node.children) walk(child);
  };
  walk(root);

  for (let i = 0; i < ctes.length; i++) {
    const cte = ctes[i]!;
    const node = cteNodes[i];
    if (!node) continue;
    const refs = new Set<string>();
    const walkRefs = (n: Node) => {
      if (n.type === 'object_reference') {
        const text = n.text.trim();
        if (text && !text.includes('.') && names.has(text) && text !== cte.name) {
          refs.add(text);
        }
      }
      for (const child of n.children) walkRefs(child);
    };
    for (const child of node.children) {
      if (child.type === 'identifier') continue;
      walkRefs(child);
    }
    cte.referencesCtes = Array.from(refs).sort();
  }
}

export function extractRelationRefsFromTree(root: Node): ExtractedRelationRef[] {
  const out: ExtractedRelationRef[] = [];
  const walk = (node: Node) => {
    if (node.type === 'object_reference') {
      const text = node.text.trim();
      if (text) out.push({ text, lineStart: lineStartOf(node) });
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}
