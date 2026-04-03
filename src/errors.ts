import { err, ok, Result } from 'neverthrow';

export type TraceMcpError =
  | { code: 'PARSE_ERROR'; file: string; partial: boolean; message: string }
  | { code: 'NOT_FOUND'; id: string; candidates?: string[] }
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

export function notFound(id: string, candidates?: string[]): TraceMcpError {
  return { code: 'NOT_FOUND', id, candidates };
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
    message: 'message' in error ? error.message : ('detail' in error ? error.detail : error.code),
  };

  if (error.code === 'NOT_FOUND' && error.candidates?.length) {
    base.suggestions = error.candidates;
    base.help = 'Use search() to find the correct symbol_id';
  }

  return { error: base };
}

export { ok, err, Result };
