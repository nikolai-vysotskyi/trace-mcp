/**
 * Embedding-model eval corpus builder (TRA-1539).
 *
 * Scans trace-mcp `src/` for exported symbols and emits one document per
 * symbol: `{ id, name, file, kind, text }` where text mirrors what the
 * indexer actually embeds (`kind + fqn/name + signature + leading comment`,
 * see `buildEmbeddingText` in `src/ai/embedding-pipeline.ts`).
 *
 * Usage: `node scripts/embedding-eval/corpus.mjs [--out <path>]`
 * Prints `<count> docs` and writes JSON to stdout (or file with --out).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ROOTS = [
  'src/ai',
  'src/retrieval',
  'src/db',
  'src/indexer',
  'src/tools/navigation',
  'src/memory',
  'src/config.ts',
  'src/project-root.ts',
  'src/registry.ts',
];

const EXPORT_RE =
  /export\s+(?:async\s+)?(?:class|function|interface|type|const|enum)\s+([A-Za-z0-9_]+)/g;
/** Per-area quota so every subsystem stays represented (no alphabetical cutoff). */
const PER_GROUP_QUOTA = 140;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/[._]test\./.test(p)) out.push(p);
  }
}

function kindOf(signature) {
  if (/^\s*(export\s+)?(async\s+)?class\b/.test(signature)) return 'class';
  if (/\binterface\b/.test(signature)) return 'interface';
  if (/\btype\b/.test(signature)) return 'type';
  if (/\bconst\b/.test(signature)) return 'const';
  if (/\benum\b/.test(signature)) return 'enum';
  return 'function';
}

function enrich(file, name, lineNo, lines) {
  const sig = (lines[lineNo - 1] || '').trim().slice(0, 220);
  const comments = [];
  for (let i = lineNo - 2; i >= Math.max(0, lineNo - 6); i--) {
    const t = lines[i].trim();
    if (t.startsWith('//')) comments.unshift(t.replace(/^\/\/\s?/, ''));
    else if (t.startsWith('*') || t.startsWith('/**') || t.startsWith('*/'))
      comments.unshift(t.replace(/^\/\*\*?|^\*\/?/, '').trim());
    else if (t === '' || t.startsWith('import ') || t.startsWith('}')) continue;
    else break;
  }
  const kind = kindOf(sig);
  const text = [kind, name, sig, comments.filter(Boolean).join(' ')].filter(Boolean).join(' ');
  return {
    id: `${path.relative(REPO_ROOT, file)}#${name}`,
    name,
    file: path.relative(REPO_ROOT, file),
    kind,
    text,
  };
}

export function buildCorpus() {
  const files = [];
  for (const r of ROOTS) {
    const p = path.join(REPO_ROOT, r);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  files.sort();
  const groups = new Map();
  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f);
    const group = rel.includes('/') ? rel.split('/').slice(0, 2).join('/') : rel;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(f);
  }
  const docs = [];
  for (const [, groupFiles] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Per-file export lists, then round-robin so one export-heavy file can't
    // starve the rest of the group (alphabetical cutoff).
    const perFile = groupFiles.map((f) => {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const src = lines.join('\n');
      const seen = new Set();
      const items = [];
      let m;
      EXPORT_RE.lastIndex = 0;
      while ((m = EXPORT_RE.exec(src)) !== null) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        items.push({
          name: m[1],
          lineNo: src.slice(0, m.index).split('\n').length,
          lines,
          file: f,
        });
      }
      return items;
    });
    let taken = 0;
    for (let round = 0; taken < PER_GROUP_QUOTA; round++) {
      let progressed = false;
      for (const items of perFile) {
        if (taken >= PER_GROUP_QUOTA) break;
        const it = items[round];
        if (!it) continue;
        docs.push(enrich(it.file, it.name, it.lineNo, it.lines));
        taken++;
        progressed = true;
      }
      if (!progressed) break;
    }
  }
  docs.sort((a, b) => (a.id < b.id ? -1 : 1));
  return docs;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const docs = buildCorpus();
  const outIdx = process.argv.indexOf('--out');
  const json = JSON.stringify(docs, null, 1);
  if (outIdx !== -1) fs.writeFileSync(process.argv[outIdx + 1], `${json}\n`);
  else process.stdout.write(`${json}\n`);
  process.stderr.write(`corpus: ${docs.length} docs\n`);
}
