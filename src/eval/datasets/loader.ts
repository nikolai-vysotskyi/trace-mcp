/**
 * Dataset loader for the eval harness.
 *
 * Datasets ship as JSON files alongside this module. The loader resolves a
 * dataset by slug, parses + validates the JSON, and returns a typed
 * `BenchmarkDataset` object.
 *
 * Validation uses zod (already a project dep) so the failure message points
 * at the exact field that's malformed instead of erroring deep inside the
 * runner.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { BenchmarkDataset } from '../types.js';

const BenchmarkCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  query: z.string().min(1),
  expected_files: z.array(z.string().min(1)).min(1),
  filters: z
    .object({
      kind: z.string().optional(),
      language: z.string().optional(),
      filePattern: z.string().optional(),
    })
    .optional(),
});

const BenchmarkDatasetSchema = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  project_root: z.string().default('.'),
  cases: z.array(BenchmarkCaseSchema).min(1),
});

/**
 * Directory containing bundled JSON datasets. Resolved relative to this
 * source file so it works both under `tsx` (running .ts directly) and
 * under the bundled `dist/cli.js` (where datasets are copied at build
 * time — see CLAUDE notes in the IMPL plan).
 *
 * At runtime, bundled tsup output lives under `dist/` while source JSON
 * lives under `src/eval/datasets/`. We probe both — first the sibling
 * directory next to the executing module, then walk up to find a
 * `src/eval/datasets/` directory in the package. This keeps the slice
 * self-contained: no postinstall copying required for the source-mode
 * use case (running via `tsx`).
 */
function resolveDatasetDir(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [here];

  // When running from dist/, the JSON files won't be co-located unless we
  // copy them at build time. As a fallback, walk up to find a sibling
  // `src/eval/datasets` directory in case the user is invoking the CLI
  // from a checked-out package.
  let cursor = here;
  for (let i = 0; i < 6; i++) {
    const sibling = path.join(cursor, 'src', 'eval', 'datasets');
    if (sibling !== here) candidates.push(sibling);
    cursor = path.dirname(cursor);
    if (cursor === path.dirname(cursor)) break;
  }
  return candidates;
}

/**
 * Resolve a dataset by slug. The slug is the `id` field; the JSON file
 * must live at `${datasetDir}/${slug}.json`.
 */
export function loadDataset(slug: string): BenchmarkDataset {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid dataset slug: ${slug}. Expected alphanumeric + dash + underscore.`);
  }

  const dirs = resolveDatasetDir();
  let lastErr: unknown = null;
  for (const dir of dirs) {
    const filePath = path.join(dir, `${slug}.json`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const parsed = BenchmarkDatasetSchema.parse(raw);
      if (parsed.id !== slug) {
        throw new Error(
          `Dataset id mismatch: file "${slug}.json" declares id "${parsed.id}". File name must match id.`,
        );
      }
      return parsed as BenchmarkDataset;
    } catch (err) {
      lastErr = err;
    }
  }

  const tried = dirs.map((d) => path.join(d, `${slug}.json`)).join(', ');
  if (lastErr instanceof z.ZodError) {
    const messages = lastErr.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Dataset "${slug}" failed validation:\n${messages}`);
  }
  throw new Error(
    `Dataset "${slug}" not found. Tried: ${tried}${
      lastErr instanceof Error ? `\nLast error: ${lastErr.message}` : ''
    }`,
  );
}

/**
 * List all bundled dataset slugs. Used by the CLI for `eval list`.
 */
export function listDatasets(): string[] {
  const seen = new Set<string>();
  for (const dir of resolveDatasetDir()) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.json')) {
        seen.add(entry.replace(/\.json$/, ''));
      }
    }
  }
  return [...seen].sort();
}

/** Exposed so tests can validate hand-crafted JSON fragments without disk I/O. */
export { BenchmarkDatasetSchema };
