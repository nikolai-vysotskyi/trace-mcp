/**
 * laravel/horizon extraction.
 *
 * Extracts:
 * - Horizon config (horizon.php) — environments, balancing strategy, queue mappings
 * - Job classes tagged with horizon metadata (queue, tries, timeout)
 * - Horizon metrics/notification classes
 * - Edges: job → queue, queue → supervisor environment
 */
import type { RawEdge, RawSymbol } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface HorizonConfigInfo {
  environments: HorizonEnvironment[];
  defaultQueue: string | null;
}

interface HorizonEnvironment {
  name: string;
  supervisors: HorizonSupervisor[];
}

interface HorizonSupervisor {
  name: string;
  queues: string[];
  balance: string | null; // 'simple' | 'auto' | 'false'
  processes: number | null;
  tries: number | null;
  timeout: number | null;
}

export interface HorizonJobInfo {
  className: string;
  fqn: string;
  queue: string | null;
  connection: string | null;
  tries: number | null;
  timeout: number | null;
  uniqueFor: number | null;
  shouldBeEncrypted: boolean;
}

// ─── Config extraction ───────────────────────────────────────

const QUEUE_CONNECTION_RE = /['"]queue['"]\s*=>\s*['"]([^'"]+)['"]/;

/**
 * Extract Horizon configuration from config/horizon.php.
 */
export function extractHorizonConfig(source: string): HorizonConfigInfo | null {
  if (!source.includes('horizon') && !source.includes('Horizon')) return null;

  const defaultQueueMatch = source.match(QUEUE_CONNECTION_RE);
  const defaultQueue = defaultQueueMatch?.[1] ?? null;

  const environments: HorizonEnvironment[] = [];

  // Match 'environments' => [ 'production' => [ 'supervisor-1' => [...] ] ]
  const envBlockRe = /['"]environments['"]\s*=>\s*\[/;
  const envMatch = envBlockRe.exec(source);
  if (envMatch) {
    const afterEnv = source.slice(envMatch.index + envMatch[0].length);
    const envBody = extractBracketBody(afterEnv);

    // Find top-level keys in environments block (depth-1 matches only)
    const topLevelEntries = extractTopLevelArrayEntries(envBody);

    for (const [envName, entryBody] of topLevelEntries) {
      const supervisors: HorizonSupervisor[] = [];

      // Find supervisors within this environment
      const supEntries = extractTopLevelArrayEntries(entryBody);
      for (const [supName, supBody] of supEntries) {
        const queues = extractArrayValues(supBody, 'queue');
        const balance = extractStringValue(supBody, 'balance');
        const processes = extractIntValue(supBody, 'processes') ?? extractIntValue(supBody, 'maxProcesses');
        const tries = extractIntValue(supBody, 'tries');
        const timeout = extractIntValue(supBody, 'timeout');

        supervisors.push({ name: supName, queues, balance, processes, tries, timeout });
      }

      if (supervisors.length > 0) {
        environments.push({ name: envName, supervisors });
      }
    }
  }

  if (environments.length === 0 && !defaultQueue) return null;

  return { environments, defaultQueue };
}

// ─── Job extraction ──────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;

/**
 * Extract Horizon-relevant job metadata from a job class.
 * Only returns info if the class implements ShouldQueue.
 */
export function extractHorizonJob(
  source: string,
  _filePath: string,
): HorizonJobInfo | null {
  if (!source.includes('ShouldQueue')) return null;
  if (!/class\s+\w+/.test(source)) return null;

  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // Extract queue properties
  const queue = extractPropertyString(source, 'queue');
  const connection = extractPropertyString(source, 'connection');
  const tries = extractPropertyInt(source, 'tries');
  const timeout = extractPropertyInt(source, 'timeout');
  const uniqueFor = extractPropertyInt(source, 'uniqueFor');
  const shouldBeEncrypted = /\$shouldBeEncrypted\s*=\s*true/.test(source)
    || source.includes('ShouldBeEncrypted');

  return { className, fqn, queue, connection, tries, timeout, uniqueFor, shouldBeEncrypted };
}

// ─── Edge builders ───────────────────────────────────────────

export function buildHorizonJobEdges(info: HorizonJobInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  if (info.queue) {
    edges.push({
      edgeType: 'horizon_job_on_queue',
      metadata: { jobFqn: info.fqn, queue: info.queue },
    });
  }

  if (info.connection) {
    edges.push({
      edgeType: 'horizon_job_connection',
      metadata: { jobFqn: info.fqn, connection: info.connection },
    });
  }

  return edges;
}

export function buildHorizonConfigEdges(config: HorizonConfigInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const env of config.environments) {
    for (const sup of env.supervisors) {
      for (const queue of sup.queues) {
        edges.push({
          edgeType: 'horizon_supervises_queue',
          metadata: {
            environment: env.name,
            supervisor: sup.name,
            queue,
            balance: sup.balance,
            processes: sup.processes,
          },
        });
      }
    }
  }

  return edges;
}

export function buildHorizonConfigSymbols(config: HorizonConfigInfo): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const env of config.environments) {
    for (const sup of env.supervisors) {
      symbols.push({
        name: `${env.name}:${sup.name}`,
        kind: 'variable',
        signature: `supervisor ${sup.name} [${sup.queues.join(', ')}] balance=${sup.balance ?? 'none'}`,
        metadata: {
          frameworkRole: 'horizon_supervisor',
          environment: env.name,
          queues: sup.queues,
          balance: sup.balance,
          processes: sup.processes,
          tries: sup.tries,
          timeout: sup.timeout,
        },
      });
    }
  }

  return symbols;
}

// ─── Internal helpers ────────────────────────────────────────

function extractPropertyString(source: string, prop: string): string | null {
  const re = new RegExp(`\\$${prop}\\s*=\\s*['"]([^'"]+)['"]`);
  return source.match(re)?.[1] ?? null;
}

function extractPropertyInt(source: string, prop: string): number | null {
  const re = new RegExp(`\\$${prop}\\s*=\\s*(\\d+)`);
  const m = source.match(re);
  return m ? parseInt(m[1], 10) : null;
}

function extractStringValue(body: string, key: string): string | null {
  const re = new RegExp(`['"]${key}['"]\\s*=>\\s*['"]([^'"]+)['"]`);
  return body.match(re)?.[1] ?? null;
}

function extractIntValue(body: string, key: string): number | null {
  const re = new RegExp(`['"]${key}['"]\\s*=>\\s*(\\d+)`);
  const m = body.match(re);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract the body of a [...] block, handling nested brackets.
 */
function extractBracketBody(source: string): string {
  let depth = 1;
  let i = 0;
  while (i < source.length && depth > 0) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
    i++;
  }
  return source.slice(0, i - 1);
}

/**
 * Extract top-level 'key' => [...] entries from a PHP array body.
 * Returns [key, body] pairs where body is the content inside the brackets.
 */
function extractTopLevelArrayEntries(body: string): [string, string][] {
  const entries: [string, string][] = [];
  const re = /['"]([\w-]+)['"]\s*=>\s*\[/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(body)) !== null) {
    // Verify this match is at top level (no unclosed brackets before it)
    const before = body.slice(0, match.index);
    let depth = 0;
    for (const ch of before) {
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }
    if (depth !== 0) continue; // skip nested matches

    const entryBody = extractBracketBody(body.slice(match.index + match[0].length));
    entries.push([match[1], entryBody]);
  }

  return entries;
}

function extractArrayValues(body: string, key: string): string[] {
  // Match 'queue' => ['default', 'emails'] or 'queue' => 'default'
  const arrayRe = new RegExp(`['"]${key}['"]\\s*=>\\s*\\[([^\\]]+)\\]`);
  const arrayMatch = body.match(arrayRe);
  if (arrayMatch) {
    return arrayMatch[1].match(/['"]([^'"]+)['"]/g)?.map(s => s.replace(/['"]/g, '')) ?? [];
  }

  const stringRe = new RegExp(`['"]${key}['"]\\s*=>\\s*['"]([^'"]+)['"]`);
  const stringMatch = body.match(stringRe);
  if (stringMatch) return [stringMatch[1]];

  return [];
}
