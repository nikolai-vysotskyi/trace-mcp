/**
 * Shared `output_format` encoder for MCP tool responses.
 *
 * Supports three formats:
 *   - "json"     — default, compact `JSON.stringify`
 *   - "markdown" — tool-specific; tools build markdown themselves before
 *                  reaching this helper. Passing "markdown" here is a
 *                  programming error.
 *   - "toon"     — Token-Oriented Object Notation (@toon-format/toon).
 *                  Lossless drop-in JSON replacement, 30-60% cheaper in
 *                  LLM tokens on tabular data.
 *   - "gcf"      — Graph Compact Format (@blackwell-systems/gcf). Lossless,
 *                  zero-dependency; path-flattens nested fields, so it matches
 *                  TOON on flat records and is smaller on nested payloads.
 */
import { z } from 'zod';
import { encodeGeneric } from '@blackwell-systems/gcf';
import { encode as toonEncode } from '@toon-format/toon';

export type OutputFormat = 'json' | 'markdown' | 'toon' | 'gcf';

export const OutputFormatSchema = z
  .enum(['json', 'markdown', 'toon', 'gcf'])
  .optional()
  .describe(
    'Output format. "json" (default) returns JSON, "markdown" returns LLM-friendly fenced markdown (tool-specific), "toon" returns Token-Oriented Object Notation and "gcf" returns Graph Compact Format — both cut LLM tokens on tabular data; gcf round-trips losslessly and also flattens nested fields.',
  );

export function isToonRequested(format: unknown): format is 'toon' {
  return format === 'toon';
}

export function isGcfRequested(format: unknown): format is 'gcf' {
  return format === 'gcf';
}

export function encodeResponse(payload: unknown, format: OutputFormat | undefined): string {
  if (format === 'markdown') {
    throw new Error(
      'encodeResponse: markdown is tool-specific; callers must build markdown themselves before reaching this helper',
    );
  }

  if (format === 'toon') {
    if (payload === null || payload === undefined || typeof payload !== 'object') {
      return JSON.stringify(payload);
    }
    try {
      return toonEncode(payload as Parameters<typeof toonEncode>[0]);
    } catch (err) {
      process.stderr.write(
        `[output-format] TOON encode failed, falling back to JSON: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return JSON.stringify(payload);
    }
  }

  if (format === 'gcf') {
    if (payload === null || payload === undefined || typeof payload !== 'object') {
      return JSON.stringify(payload);
    }
    try {
      return encodeGeneric(payload);
    } catch (err) {
      process.stderr.write(
        `[output-format] GCF encode failed, falling back to JSON: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return JSON.stringify(payload);
    }
  }

  return JSON.stringify(payload);
}
