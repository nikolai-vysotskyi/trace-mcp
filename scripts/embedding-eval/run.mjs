/**
 * Embedding-model eval runner (TRA-1539).
 *
 * Compares ONNX embedding candidates on a code corpus (see corpus.mjs) with
 * labeled description→code queries (see queries.json):
 *
 *   - minilm-fp32  Xenova/all-MiniLM-L6-v2, dtype fp32 (today's explicit setting)
 *   - minilm-q8    same model, dtype q8 (today's default since the q8 switch)
 *   - e5-prefix    Xenova/multilingual-e5-small, dtype q8, WITH query:/passage: prefixes
 *   - e5-bare      same model WITHOUT prefixes (quantifies the E5 footgun)
 *   - bge-m3       Xenova/bge-m3, dtype q8 (opt-in candidate, 1024-dim)
 *
 * Metrics per model: dim, load ms, corpus ms/text, query ms, ΔRSS on
 * load/embed, HF-cache bytes downloaded, recall@1/5/10, MRR.
 *
 * Usage (run from the trace-mcp repo root):
 *   node scripts/embedding-eval/run.mjs [--models minilm-q8,e5-prefix] [--out docs/perf]
 *
 * Writes embedding-eval.json + embedding-eval.md into --out. The .md table is
 * meant to be pasted into docs/perf/embedding-models.md (the decision record).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MODELS = {
  'minilm-fp32': { hf: 'Xenova/all-MiniLM-L6-v2', dtype: 'fp32', dim: 384, prefixes: null },
  'minilm-q8': { hf: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', dim: 384, prefixes: null },
  'e5-prefix': {
    hf: 'Xenova/multilingual-e5-small',
    dtype: 'q8',
    dim: 384,
    prefixes: { query: 'query: ', doc: 'passage: ' },
  },
  'e5-bare': { hf: 'Xenova/multilingual-e5-small', dtype: 'q8', dim: 384, prefixes: null },
  'bge-m3': { hf: 'Xenova/bge-m3', dtype: 'q8', dim: 1024, prefixes: null },
};

const BATCH = 16;

function args() {
  const out = { models: Object.keys(MODELS), outDir: path.join(REPO_ROOT, 'docs', 'perf') };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--models')
      out.models = process.argv[++i].split(',').map((s) => s.trim());
    if (process.argv[i] === '--out') out.outDir = path.resolve(process.argv[++i]);
  }
  return out;
}

function cacheDir() {
  return (
    process.env.HF_HUB_CACHE ||
    process.env.TRANSFORMERS_CACHE ||
    (globalThis.__transformersCacheDir ?? path.join(os.homedir(), '.cache', 'huggingface'))
  );
}

function dirBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else total += fs.statSync(p).size;
    } catch {
      /* race — ignore */
    }
  }
  return total;
}

const rssMB = () => process.memoryUsage().rss / 1048576;

function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedBatch(pipe, texts, dim) {
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  const flat = Array.from(out.data);
  const [n, w] = out.dims;
  if (n !== texts.length)
    throw new Error(`batch shape mismatch: dims=[${n},${w}] for ${texts.length} texts`);
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(flat.slice(i * w, (i + 1) * w).slice(0, dim));
  return rows;
}

async function main() {
  const { models, outDir } = args();
  const { buildCorpus } = await import('./corpus.mjs');
  const { queries } = JSON.parse(fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf8'));
  const { pipeline, env } = await import('@huggingface/transformers');
  if (env.cacheDir) globalThis.__transformersCacheDir = env.cacheDir;

  const corpus = buildCorpus();
  const idIndex = new Map(corpus.map((d, i) => [d.id, i]));
  for (const q of queries) {
    for (const t of q.targets) {
      if (!idIndex.has(t)) throw new Error(`query ${q.id}: target not in corpus: ${t}`);
    }
  }

  const results = [];
  for (const name of models) {
    const cfg = MODELS[name];
    if (!cfg) throw new Error(`unknown model: ${name}`);
    const r = { model: name, hf: cfg.hf, dtype: cfg.dtype, dim: cfg.dim, prefixes: !!cfg.prefixes };
    process.stdout.write(`\n=== ${name} (${cfg.hf}, ${cfg.dtype}) ===\n`);
    try {
      const cacheBefore = dirBytes(cacheDir());
      const rssBefore = rssMB();
      const t0 = Date.now();
      const pipe = await pipeline('feature-extraction', cfg.hf, { dtype: cfg.dtype });
      r.load_ms = Date.now() - t0;
      r.rss_load_mb = +(rssMB() - rssBefore).toFixed(1);
      r.cache_download_mb = +((dirBytes(cacheDir()) - cacheBefore) / 1048576).toFixed(1);

      const docTexts = corpus.map((d) => (cfg.prefixes ? cfg.prefixes.doc + d.text : d.text));
      const queryTexts = queries.map((q) =>
        cfg.prefixes ? cfg.prefixes.query + q.query : q.query,
      );

      const rssPreEmbed = rssMB();
      const e0 = Date.now();
      const docVecs = [];
      for (let i = 0; i < docTexts.length; i += BATCH) {
        docVecs.push(...(await embedBatch(pipe, docTexts.slice(i, i + BATCH), cfg.dim)));
        if ((i / BATCH) % 10 === 0) process.stdout.write(`  docs ${i}/${docTexts.length}\r`);
      }
      const e1 = Date.now();
      const qVecs = [];
      for (const qt of queryTexts) {
        const t0q = Date.now();
        qVecs.push((await embedBatch(pipe, [qt], cfg.dim))[0]);
        r.query_ms_sum = (r.query_ms_sum ?? 0) + (Date.now() - t0q);
      }
      r.corpus_ms_per_text = +((e1 - e0) / docTexts.length).toFixed(2);
      r.query_ms = +((r.query_ms_sum ?? 0) / queryTexts.length).toFixed(2);
      delete r.query_ms_sum;
      r.rss_embed_mb = +(rssMB() - rssPreEmbed).toFixed(1);
      r.corpus_docs = docTexts.length;

      // Rank + score.
      let mrr = 0;
      const hits = { 1: 0, 5: 0, 10: 0 };
      for (let qi = 0; qi < queries.length; qi++) {
        const scored = docVecs
          .map((v, di) => [cosine(qVecs[qi], v), di])
          .sort((a, b) => b[0] - a[0]);
        const rankOf = new Map(scored.map(([_, di], rank) => [di, rank + 1]));
        let best = Infinity;
        for (const t of queries[qi].targets) {
          best = Math.min(best, rankOf.get(idIndex.get(t)));
        }
        mrr += 1 / best;
        for (const k of [1, 5, 10]) if (best <= k) hits[k]++;
      }
      r.mrr = +(mrr / queries.length).toFixed(3);
      r.recall_at_1 = +(hits[1] / queries.length).toFixed(3);
      r.recall_at_5 = +(hits[5] / queries.length).toFixed(3);
      r.recall_at_10 = +(hits[10] / queries.length).toFixed(3);
      r.query_count = queries.length;
      r.status = 'ok';
      process.stdout.write(
        `  load=${r.load_ms}ms dl=${r.cache_download_mb}MB ms/txt=${r.corpus_ms_per_text} ` +
          `R@1=${r.recall_at_1} R@5=${r.recall_at_5} R@10=${r.recall_at_10} MRR=${r.mrr}\n`,
      );
    } catch (err) {
      r.status = `error: ${(err && err.message) || err}`;
      process.stdout.write(`  FAILED: ${r.status}\n`);
    }
    results.push(r);
    global.gc?.();
  }

  const report = {
    generated_at: new Date().toISOString(),
    machine: `${os.cpus()[0]?.model || '?'} / ${(os.totalmem() / 1073741824).toFixed(0)}GB / ${os.platform()} ${os.arch()}`,
    node: process.version,
    corpus_docs: corpus.length,
    query_count: queries.length,
    batch: BATCH,
    pooling: 'mean, normalize:true (matches src/ai/onnx.ts)',
    note: 'In-memory cosine over description→code pairs. Isolates embedding quality from FTS/hybrid fusion. bge-m3 uses mean pooling (its native CLS differs — see decision doc).',
    results,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'embedding-eval.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const md = [
    '---',
    'layout: default',
    'title: Embedding eval results (TRA-1539)',
    'noindex: true',
    '---',
    '# Embedding eval (TRA-1539)',
    '',
    `- generated: \`${report.generated_at}\``,
    `- machine: ${report.machine}, node ${report.node}`,
    `- corpus: ${report.corpus_docs} code-symbol docs, ${report.query_count} labeled description→code queries`,
    '',
    '| model | dim | load ms | dl MB | ms/text | ms/query | ΔRSS load MB | ΔRSS embed MB | R@1 | R@5 | R@10 | MRR |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) =>
      r.status === 'ok'
        ? `| ${r.model} | ${r.dim} | ${r.load_ms} | ${r.cache_download_mb} | ${r.corpus_ms_per_text} | ${r.query_ms} | ${r.rss_load_mb} | ${r.rss_embed_mb} | ${r.recall_at_1} | ${r.recall_at_5} | ${r.recall_at_10} | ${r.mrr} |`
        : `| ${r.model} | ${r.dim} | FAILED: ${r.status} |`,
    ),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'embedding-eval.md'), `${md}\n`);
  process.stdout.write(`\nwrote ${path.join(outDir, 'embedding-eval.json')}\n`);
}

main().catch((e) => {
  process.stderr.write(`eval failed: ${e.stack || e}\n`);
  process.exit(2);
});
