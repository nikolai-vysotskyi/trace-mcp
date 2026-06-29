/**
 * SCIP indexer auto-detection and configuration resolution.
 * Mirrors src/lsp/config.ts but for offline SCIP indexers.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';

export interface ScipIndexerSpec {
  language: string;
  command: string;
  args: string[];
  /** Output `.scip` path the indexer is expected to produce (relative to root). */
  outputFile: string;
  timeoutMs: number;
}

interface KnownIndexer {
  language: string;
  command: string;
  /** Args including the output flag; `{out}` is substituted with outputFile. */
  args: string[];
  outputFile: string;
  detect: (rootPath: string) => boolean;
}

/**
 * Known offline SCIP indexers. `detect` gates on project-shape so we never run
 * an indexer for an irrelevant repo. Commands must be on PATH to be selected.
 */
const KNOWN_INDEXERS: KnownIndexer[] = [
  {
    language: 'typescript',
    command: 'scip-typescript',
    args: ['index', '--output', '{out}'],
    outputFile: 'index.scip',
    detect: (root) =>
      existsSync(join(root, 'tsconfig.json')) || existsSync(join(root, 'package.json')),
  },
  {
    language: 'python',
    command: 'scip-python',
    args: ['index', '--output', '{out}'],
    outputFile: 'index.scip',
    detect: (root) =>
      existsSync(join(root, 'pyproject.toml')) ||
      existsSync(join(root, 'requirements.txt')) ||
      existsSync(join(root, 'setup.py')),
  },
  {
    language: 'rust',
    // rust-analyzer emits SCIP via `scip` subcommand.
    command: 'rust-analyzer',
    args: ['scip', '.', '--output', '{out}'],
    outputFile: 'index.scip',
    detect: (root) => existsSync(join(root, 'Cargo.toml')),
  },
];

/** Map a trace-mcp file language string to a SCIP indexer language id. */
export function fileLanguageToScipLanguage(fileLanguage: string | null): string | null {
  if (!fileLanguage) return null;
  const map: Record<string, string> = {
    typescript: 'typescript',
    javascript: 'typescript',
    python: 'python',
    rust: 'rust',
  };
  return map[fileLanguage] ?? null;
}

/** Check whether a command exists on PATH. */
function isCommandAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which SCIP indexers to run, based on config + auto-detection.
 * Returns specs for indexers that are relevant, available, and detected.
 *
 * Note: when `config.scip.index_path` is set the caller ingests that file
 * directly and never asks for indexer specs — this function is only consulted
 * for the run-an-indexer-offline path.
 */
export function resolveScipIndexers(
  config: TraceMcpConfig,
  rootPath: string,
  indexedLanguages: Set<string>,
): ScipIndexerSpec[] {
  const specs: ScipIndexerSpec[] = [];
  const seen = new Set<string>();

  // 1. Explicit indexer overrides from user config.
  if (config.scip?.indexers) {
    for (const [language, indexerConfig] of Object.entries(config.scip.indexers)) {
      if (seen.has(language)) continue;
      seen.add(language);
      if (!isCommandAvailable(indexerConfig.command)) {
        logger.info(
          { language, command: indexerConfig.command },
          'SCIP indexer command not found, skipping',
        );
        continue;
      }
      const outputFile = 'index.scip';
      specs.push({
        language,
        command: indexerConfig.command,
        args: indexerConfig.args.map((a) => a.replace('{out}', outputFile)),
        outputFile,
        timeoutMs: indexerConfig.timeout_ms,
      });
    }
  }

  // 2. Auto-detect additional indexers.
  if (config.scip?.auto_detect !== false) {
    for (const known of KNOWN_INDEXERS) {
      if (seen.has(known.language)) continue;
      if (!indexedLanguages.has(known.language)) continue;
      if (!known.detect(rootPath)) continue;
      if (!isCommandAvailable(known.command)) {
        logger.debug(
          { language: known.language, command: known.command },
          'SCIP indexer not installed',
        );
        continue;
      }
      seen.add(known.language);
      specs.push({
        language: known.language,
        command: known.command,
        args: known.args.map((a) => a.replace('{out}', known.outputFile)),
        outputFile: known.outputFile,
        timeoutMs: config.scip?.ingestion_timeout_ms ?? 120_000,
      });
    }
  }

  return specs;
}
