/**
 * The measurement everyone forgets (TRA-758): what the selector costs the
 * client machine per tool call. The encoder cost +1.6 s and +198 MB; a
 * structural selector runs no model, so this is the number that has to be
 * near zero for the direction to have been worth trying at all.
 */
import { getParser } from '../../src/parser/tree-sitter.js';

const sample = process.argv[2] ?? 'src/server/server.ts';
const src = await import('node:fs').then((fs) => fs.readFileSync(sample, 'utf8'));
const base = process.memoryUsage().rss;

const t0 = performance.now();
const parser = await getParser('typescript');
parser.parse(src);
const cold = performance.now() - t0;

const runs: number[] = [];
for (let i = 0; i < 50; i++) {
  const t = performance.now();
  parser.parse(src);
  runs.push(performance.now() - t);
}
runs.sort((a, b) => a - b);
console.log(`file: ${sample} (${(src.length / 1024).toFixed(1)} KB)`);
console.log(`cold (grammar load + first parse): ${cold.toFixed(1)} ms`);
console.log(`warm parse p50: ${runs[25].toFixed(2)} ms, p95: ${runs[47].toFixed(2)} ms`);
console.log(`RSS delta: ${((process.memoryUsage().rss - base) / 1e6).toFixed(1)} MB`);
