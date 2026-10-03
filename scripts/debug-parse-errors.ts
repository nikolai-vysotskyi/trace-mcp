import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWasmPath } from 'tree-sitter-wasm';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { preprocessSqlForParse } from '../src/indexer/plugins/language/sql/preprocess.js';

const rel = process.argv[2] ?? 'parent_etl.sql';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus =
  process.env.TRACE_SQL_CORPUS_ROOT ??
  path.join(repoRoot, '../data-analytics-python/scripts/queries');
const abs = path.join(corpus, rel);

function collectErrors(node: Node, out: string[], limit: number) {
  if (out.length >= limit) return;
  if (node.type === 'ERROR' || node.isMissing) {
    const line = node.startPosition.row + 1;
    out.push(`L${line}: ${node.text.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  for (const c of node.children) collectErrors(c, out, limit);
}

async function main() {
  const raw = fs.readFileSync(abs, 'utf8');
  const source = preprocessSqlForParse(raw).source;
  await Parser.init();
  const lang = await Language.load(getWasmPath('sql'));
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const errors: string[] = [];
  collectErrors(tree.rootNode, errors, 15);
  console.log(rel, 'root', tree.rootNode.type, 'hasError', tree.rootNode.hasError);
  for (const e of errors) console.log(' ', e);
  tree.delete();
}

main();
