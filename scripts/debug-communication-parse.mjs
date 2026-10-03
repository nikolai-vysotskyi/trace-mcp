import { getWasmPath } from 'tree-sitter-wasm';
import { Parser, Language } from 'web-tree-sitter';
import fs from 'fs';

function normalizeAtTimeZone(source) {
  let s = source;
  s = s.replace(
    /\(\s*([^()]+?)\s+AT\s+TIME\s+ZONE\s+'[^']*'\s*\)\s+AT\s+TIME\s+ZONE\s+'[^']*'/gi,
    '($1)',
  );
  s = s.replace(/\s+AT\s+TIME\s+ZONE\s+'[^']*'/gi, '');
  return s;
}

await Parser.init();
const lang = await Language.load(getWasmPath('sql'));
const parser = new Parser();
parser.setLanguage(lang);

const root =
  '/Users/ishansarkar/BrightChamps - Work/BitBucket/data-analytics-python/scripts/queries';
for (const rel of [
  'communication_etl_queries/communication_etl_incremental.sql',
  'communication_etl_queries/communication_etl_historical.sql',
]) {
  const raw = fs.readFileSync(`${root}/${rel}`, 'utf8');
  const src = normalizeAtTimeZone(raw);
  const tree = parser.parse(src);
  const ctes = [];
  const walk = (n) => {
    if (n.type === 'cte') {
      const id = n.children.find((c) => c.type === 'identifier');
      if (id) ctes.push(id.text);
    }
    for (const c of n.children) walk(c);
  };
  walk(tree.rootNode);
  console.log(rel, 'root', tree.rootNode.type, 'hasError', tree.rootNode.hasError, 'ctes', ctes);
  tree.delete();
}
