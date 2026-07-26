import type { Result } from 'neverthrow';

/** Why a NOT_FOUND lookup missed — lets callers react instead of just retrying blind. */
export type NotFoundReason = 'not_indexed' | 'not_found' | 'unknown_symbol';

export type TraceMcpError =
  | { code: 'PARSE_ERROR'; file: string; partial: boolean; message: string }
  | { code: 'NOT_FOUND'; id: string; candidates?: string[]; reason?: NotFoundReason }
  | { code: 'RESOLUTION_FAILED'; path: string; message: string }
  | { code: 'TIMEOUT'; operation: string; ms: number }
  | { code: 'SECURITY_VIOLATION'; detail: string }
  | { code: 'PLUGIN_ERROR'; plugin: string; message: string }
  | { code: 'DB_ERROR'; message: string }
  | { code: 'CONFIG_ERROR'; message: string }
  | { code: 'VALIDATION_ERROR'; message: string; details?: unknown };

export type TraceMcpResult<T> = Result<T, TraceMcpError>;

export function parseError(file: string, message: string, partial = false): TraceMcpError {
  return { code: 'PARSE_ERROR', file, partial, message };
}

export function notFound(id: string, candidates?: string[], reason?: NotFoundReason): TraceMcpError {
  return { code: 'NOT_FOUND', id, candidates, reason };
}

export function securityViolation(detail: string): TraceMcpError {
  return { code: 'SECURITY_VIOLATION', detail };
}

export function pluginError(plugin: string, message: string): TraceMcpError {
  return { code: 'PLUGIN_ERROR', plugin, message };
}

export function dbError(message: string): TraceMcpError {
  return { code: 'DB_ERROR', message };
}

export function configError(message: string): TraceMcpError {
  return { code: 'CONFIG_ERROR', message };
}

export function validationError(message: string, details?: unknown): TraceMcpError {
  return { code: 'VALIDATION_ERROR', message, details };
}

export function formatToolError(error: TraceMcpError): object {
  const base: Record<string, unknown> = {
    code: error.code,
    message: 'message' in error ? error.message : 'detail' in error ? error.detail : error.code,
  };

  if (error.code === 'NOT_FOUND') {
    base.message = `'${error.id}' is not in the index`;
    if (error.reason) base.reason = error.reason;
    if (error.candidates?.length) {
      base.suggestions = error.candidates;
      base.help = 'Use search() to find the correct symbol_id';
    } else if (error.reason === 'not_indexed') {
      base.help =
        'File exists but could not be parsed on demand — it may not match the configured include globs. Check `include`/`exclude` in .trace-mcp.json and run reindex.';
    } else if (error.reason === 'not_found') {
      base.help = 'No file exists at this path. Use search() to locate the correct path.';
    } else {
      base.help =
        'If this is a file path, it may not match the configured include globs — check `include`/`exclude` in .trace-mcp.json and reindex. Otherwise use search() to locate the symbol.';
    }
  }

  return { error: base };
}

export { err, ok } from 'neverthrow';
export type { Result };
