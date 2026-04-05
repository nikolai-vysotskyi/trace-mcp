// @ts-nocheck
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

const parser = new Parser();
parser.setLanguage(TypeScript.typescript);

export function parseSource(source: string) {
  const tree = parser.parse(source);
  return tree.rootNode;
}

export function findFunctions(source: string) {
  const tree = parser.parse(source);
  const root = tree.rootNode;
  const functions: string[] = [];

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (child?.type === 'function_declaration') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) functions.push(nameNode.text);
    }
  }

  return functions;
}
