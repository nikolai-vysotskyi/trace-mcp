/**
 * ScipBridge — orchestrator for SCIP ingestion.
 *
 * Two modes, decided by config:
 *  - `index_path` set: ingest that pre-built `.scip` file directly (CI path —
 *    the index was produced by an earlier build step). No indexer is run.
 *  - otherwise: auto-detect installed SCIP indexers, run each one offline into
 *    a temp `.scip`, and ingest the output.
 *
 * Disabled by default (`scip.enabled === false`) — zero overhead when off. All
 * failures are caught and logged; SCIP is best-effort precision enrichment, so
 * a missing indexer or malformed index never breaks indexing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import { fileLanguageToScipLanguage, resolveScipIndexers } from './config.js';
import { ingestScipBytes, type ScipIngestResult } from './ingest.js';

export interface ScipBridgeResult {
  edgesUpgraded: number;
  edgesAdded: number;
  documentsProcessed: number;
  indexersRun: string[];
  durationMs: number;
}

function emptyBridgeResult(): ScipBridgeResult {
  return {
    edgesUpgraded: 0,
    edgesAdded: 0,
    documentsProcessed: 0,
    indexersRun: [],
    durationMs: 0,
  };
}

function mergeIngest(into: ScipBridgeResult, r: ScipIngestResult): void {
  into.edgesUpgraded += r.edgesUpgraded;
  into.edgesAdded += r.edgesAdded;
  into.documentsProcessed += r.documentsProcessed;
}

export class ScipBridge {
  constructor(
    private readonly store: Store,
    private readonly config: TraceMcpConfig,
    private readonly rootPath: string,
  ) {}

  /**
   * Run SCIP ingestion. Returns a summary; never throws (best-effort).
   */
  async ingest(): Promise<ScipBridgeResult> {
    const startTime = Date.now();
    const result = emptyBridgeResult();

    // Mode A: a pre-built index path was supplied — ingest it directly.
    const indexPath = this.config.scip?.index_path;
    if (indexPath) {
      const abs = isAbsolute(indexPath) ? indexPath : resolve(this.rootPath, indexPath);
      if (!existsSync(abs)) {
        logger.warn({ indexPath: abs }, 'SCIP index_path does not exist, skipping');
        result.durationMs = Date.now() - startTime;
        return result;
      }
      try {
        const bytes = readFileSync(abs);
        mergeIngest(result, ingestScipBytes(this.store, bytes));
        result.indexersRun.push('index_path');
      } catch (e) {
        logger.warn({ error: (e as Error).message }, 'Failed to ingest SCIP index_path');
      }
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Mode B: run detected indexers offline, then ingest each output.
    const indexedLanguages = this.detectIndexedLanguages();
    if (indexedLanguages.size === 0) {
      logger.debug('No SCIP-supported languages in index, skipping ingestion');
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const specs = resolveScipIndexers(this.config, this.rootPath, indexedLanguages);
    if (specs.length === 0) {
      logger.info('No SCIP indexers available, skipping ingestion');
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const timeoutMs = this.config.scip?.ingestion_timeout_ms ?? 120_000;

    for (const spec of specs) {
      if (Date.now() - startTime > timeoutMs) {
        logger.info('SCIP ingestion timeout reached, stopping');
        break;
      }
      const outAbs = join(this.rootPath, spec.outputFile);
      try {
        logger.info({ language: spec.language, command: spec.command }, 'Running SCIP indexer');
        execFileSync(spec.command, spec.args, {
          cwd: this.rootPath,
          stdio: 'pipe',
          timeout: spec.timeoutMs,
        });
        if (!existsSync(outAbs)) {
          logger.warn(
            { language: spec.language, expected: outAbs },
            'SCIP indexer produced no output file',
          );
          continue;
        }
        const bytes = readFileSync(outAbs);
        mergeIngest(result, ingestScipBytes(this.store, bytes));
        result.indexersRun.push(spec.language);
      } catch (e) {
        logger.warn(
          { language: spec.language, error: (e as Error).message },
          'SCIP indexer failed',
        );
      } finally {
        // Clean up the generated index file we created.
        if (existsSync(outAbs)) {
          try {
            rmSync(outAbs);
          } catch {
            // non-fatal
          }
        }
      }
    }

    result.durationMs = Date.now() - startTime;
    logger.info(
      {
        upgraded: result.edgesUpgraded,
        added: result.edgesAdded,
        documents: result.documentsProcessed,
        indexers: result.indexersRun,
        durationMs: result.durationMs,
      },
      'SCIP ingestion completed',
    );
    return result;
  }

  /** Which SCIP-supported languages are present in the index. */
  private detectIndexedLanguages(): Set<string> {
    const languages = new Set<string>();
    for (const file of this.store.getAllFiles()) {
      const lang = fileLanguageToScipLanguage(file.language);
      if (lang) languages.add(lang);
    }
    return languages;
  }
}
