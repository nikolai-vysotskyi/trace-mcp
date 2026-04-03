import path from 'node:path';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { securityViolation } from '../errors.js';

const DEFAULT_SECRET_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /key/i,
  /credential/i,
  /api_key/i,
  /private_key/i,
];

const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB

const ARTISAN_WHITELIST = new Set(['route:list', 'model:show', 'event:list']);

export interface SecurityConfig {
  secretPatterns?: string[];
  maxFileSizeBytes?: number;
  rootPath: string;
}

export function validatePath(filePath: string, rootPath: string): TraceMcpResult<string> {
  const resolved = path.resolve(rootPath, filePath);
  const normalizedRoot = path.resolve(rootPath);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    return err(securityViolation(`Path traversal detected: ${filePath}`));
  }

  return ok(resolved);
}

export function detectSecrets(
  content: string,
  patterns?: string[],
): { found: boolean; matches: string[] } {
  const regexes = patterns?.length
    ? patterns.map((p) => new RegExp(p, 'i'))
    : DEFAULT_SECRET_PATTERNS;

  const matches: string[] = [];
  for (const regex of regexes) {
    if (regex.test(content)) {
      matches.push(regex.source);
    }
  }

  return { found: matches.length > 0, matches };
}

export function validateFileSize(
  sizeBytes: number,
  maxBytes?: number,
): TraceMcpResult<void> {
  const limit = maxBytes ?? DEFAULT_MAX_FILE_SIZE;
  if (sizeBytes > limit) {
    return err(
      securityViolation(`File size ${sizeBytes} exceeds limit ${limit}`),
    );
  }
  return ok(undefined);
}

export function validateArtisanCommand(command: string): TraceMcpResult<string> {
  if (!ARTISAN_WHITELIST.has(command)) {
    return err(
      securityViolation(
        `Artisan command '${command}' not in whitelist: [${[...ARTISAN_WHITELIST].join(', ')}]`,
      ),
    );
  }
  return ok(command);
}
