/**
 * Parses .env files and extracts keys with inferred value types/formats.
 * Never exposes actual values — only structural metadata.
 */

export type EnvValueType = 'string' | 'number' | 'boolean' | 'empty';

export type EnvValueFormat =
  | 'url'
  | 'email'
  | 'ip'
  | 'host:port'
  | 'path'
  | 'uuid'
  | 'json'
  | 'base64'
  | 'csv'
  | 'integer'
  | 'float'
  | 'cron'
  | 'duration'
  | 'semver'
  | 'hex'
  | 'dsn'
  | null;

export interface EnvEntry {
  key: string;
  valueType: EnvValueType;
  valueFormat: EnvValueFormat;
  comment: string | null;
  /** Whether the value was wrapped in quotes */
  quoted: boolean;
  line: number;
}

// ─── Format detectors (order matters: most specific first) ───────────

const FORMAT_DETECTORS: Array<{ format: EnvValueFormat; test: (v: string) => boolean }> = [
  // UUID: 8-4-4-4-12 hex digits
  { format: 'uuid', test: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) },
  // URL: scheme://...
  { format: 'url', test: (v) => /^https?:\/\/.+/i.test(v) || /^(redis|amqp|mqtt|ftp|ftps|ssh|wss?|mongodb(\+srv)?|postgres(ql)?|mysql|sqlite):\/\/.+/i.test(v) },
  // DSN: scheme://user:pass@host or scheme://host — covers DB connection strings not caught by URL
  { format: 'dsn', test: (v) => /^[a-z][a-z0-9+.-]*:\/\/.+/i.test(v) },
  // Email
  { format: 'email', test: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) },
  // Semver: 1.2.3 or v1.2.3 with optional pre-release
  { format: 'semver', test: (v) => /^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(v) },
  // IP v4
  { format: 'ip', test: (v) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) },
  // host:port (after IP check to not conflict)
  { format: 'host:port', test: (v) => /^[\w.-]+:\d{1,5}$/.test(v) },
  // Cron expression (5 or 6 fields)
  { format: 'cron', test: (v) => /^(\S+\s+){4,5}\S+$/.test(v) && /[*\/,\-]/.test(v) },
  // JSON object or array
  { format: 'json', test: (v) => (v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']')) },
  // CSV: contains commas (and not JSON)
  { format: 'csv', test: (v) => v.includes(',') && !v.startsWith('{') && !v.startsWith('[') },
  // Duration: 30s, 5m, 2h, 1d, 500ms
  { format: 'duration', test: (v) => /^\d+(ms|s|m|h|d)$/i.test(v) },
  // Hex string (at least 8 chars to avoid matching short words)
  { format: 'hex', test: (v) => /^(0x)?[0-9a-f]{8,}$/i.test(v) && !/^\d+$/.test(v) },
  // Base64: long alphanumeric with padding or mixed case + digits (at least 16 chars)
  { format: 'base64', test: (v) => v.length >= 16 && /^[A-Za-z0-9+/]+=*$/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) },
  // Absolute path (unix or windows)
  { format: 'path', test: (v) => /^(\/[\w.-]+)+\/?$/.test(v) || /^[A-Z]:\\/.test(v) },
];

function inferType(value: string): { valueType: EnvValueType; valueFormat: EnvValueFormat } {
  if (value === '') return { valueType: 'empty', valueFormat: null };

  // Boolean
  if (/^(true|false|yes|no|on|off|1|0)$/i.test(value)) {
    return { valueType: 'boolean', valueFormat: null };
  }

  // Integer
  if (/^-?\d+$/.test(value)) {
    return { valueType: 'number', valueFormat: 'integer' };
  }

  // Float
  if (/^-?\d+\.\d+$/.test(value)) {
    return { valueType: 'number', valueFormat: 'float' };
  }

  // String with format detection
  for (const { format, test } of FORMAT_DETECTORS) {
    if (test(value)) {
      return { valueType: 'string', valueFormat: format };
    }
  }

  return { valueType: 'string', valueFormat: null };
}

/**
 * Strip surrounding quotes from a value and return whether it was quoted.
 */
function unquote(raw: string): { value: string; quoted: boolean } {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return { value: raw.slice(1, -1), quoted: true };
  }
  return { value: raw, quoted: false };
}

/**
 * Parse a .env file content and return structured entries without actual values.
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const lines = content.split('\n');
  let pendingComment: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Blank line resets pending comment
    if (line === '') {
      pendingComment = null;
      continue;
    }

    // Comment line — accumulate for next variable
    if (line.startsWith('#')) {
      const commentText = line.slice(1).trim();
      pendingComment = pendingComment ? `${pendingComment} ${commentText}` : commentText;
      continue;
    }

    // Variable line: KEY=VALUE or export KEY=VALUE
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
    if (!match) {
      pendingComment = null;
      continue;
    }

    const key = match[1];
    const rawValue = match[2].trim();

    // Strip inline comment (only for unquoted values)
    let effectiveRaw = rawValue;
    if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
      const commentIdx = rawValue.indexOf(' #');
      if (commentIdx !== -1) {
        effectiveRaw = rawValue.slice(0, commentIdx).trim();
      }
    }

    const { value, quoted } = unquote(effectiveRaw);
    const { valueType, valueFormat } = inferType(value);

    entries.push({
      key,
      valueType,
      valueFormat,
      comment: pendingComment,
      quoted,
      line: i + 1,
    });

    pendingComment = null;
  }

  return entries;
}

/**
 * Redact .env file content: keep keys and comments, replace values with type hints.
 * Used by source-reader to safely expose .env structure without secrets.
 */
export function redactEnvFile(content: string): string {
  const entries = parseEnvFile(content);
  const lines = content.split('\n');
  const result: string[] = [];

  const entryByLine = new Map<number, EnvEntry>();
  for (const e of entries) {
    entryByLine.set(e.line, e);
  }

  for (let i = 0; i < lines.length; i++) {
    const entry = entryByLine.get(i + 1);
    if (entry) {
      const typeHint = formatTypeHint(entry);
      result.push(`${entry.key}=${typeHint}`);
    } else {
      // Keep comments and blank lines as-is
      result.push(lines[i]);
    }
  }

  return result.join('\n');
}

function formatTypeHint(entry: EnvEntry): string {
  if (entry.valueType === 'empty') return '<empty>';
  if (entry.valueFormat) return `<${entry.valueType}:${entry.valueFormat}>`;
  return `<${entry.valueType}>`;
}
