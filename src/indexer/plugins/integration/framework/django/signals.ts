/**
 * Django signal extraction from Python source files.
 *
 * Detects:
 * - @receiver(post_save, sender=User) decorator pattern
 * - signal.connect(handler, sender=User) imperative pattern
 * - Common Django signals: pre_save, post_save, pre_delete, post_delete,
 *   m2m_changed, pre_init, post_init, pre_migrate, post_migrate, request_started, etc.
 */
import type { RawEdge } from '../../../../../plugin-api/types.js';

interface SignalConnection {
  signal: string;
  handler: string;
  sender?: string;
  line: number;
}

/**
 * Extract signal connections from Django source code.
 * Returns edges of type django_signal_receiver.
 */
export function extractSignalConnections(
  source: string,
  filePath: string,
): RawEdge[] {
  const edges: RawEdge[] = [];
  const connections = [
    ...extractReceiverDecorators(source),
    ...extractConnectCalls(source),
  ];

  for (const conn of connections) {
    edges.push({
      edgeType: 'django_signal_receiver',
      metadata: {
        signal: conn.signal,
        handler: conn.handler,
        sender: conn.sender,
        filePath,
        line: conn.line,
      },
    });
  }

  return edges;
}

/**
 * Extract @receiver(signal, sender=Model) patterns.
 *
 * Handles:
 * - @receiver(post_save, sender=User)
 * - @receiver(post_save, sender='myapp.User')
 * - @receiver([post_save, post_delete], sender=User)
 */
function extractReceiverDecorators(source: string): SignalConnection[] {
  const connections: SignalConnection[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match @receiver(...) decorator
    const decoratorMatch = line.match(
      /^@receiver\s*\(\s*(.+)\s*\)\s*$/,
    );
    if (!decoratorMatch) continue;

    const argsStr = decoratorMatch[1];

    // Find the function name on the next non-decorator, non-empty line
    let handler = '';
    for (let j = i + 1; j < lines.length && j < i + 5; j++) {
      const nextLine = lines[j].trim();
      if (!nextLine || nextLine.startsWith('@')) continue;
      const funcMatch = nextLine.match(/^(?:async\s+)?def\s+(\w+)/);
      if (funcMatch) {
        handler = funcMatch[1];
      }
      break;
    }

    if (!handler) continue;

    // Parse signal(s) and sender
    const sender = extractSender(argsStr);
    const signals = extractSignalNames(argsStr);

    for (const signal of signals) {
      connections.push({
        signal,
        handler,
        sender: sender ?? undefined,
        line: i + 1,
      });
    }
  }

  return connections;
}

/**
 * Extract signal.connect(handler, sender=Model) patterns.
 *
 * Handles:
 * - post_save.connect(my_handler, sender=User)
 * - signals.post_save.connect(handler, sender=User)
 */
function extractConnectCalls(source: string): SignalConnection[] {
  const connections: SignalConnection[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const connectMatch = line.match(
      /(?:(?:signals?\.)?(\w+))\.connect\s*\(\s*(\w+)(?:\s*,\s*(.+))?\s*\)/,
    );
    if (!connectMatch) continue;

    const signal = connectMatch[1];
    const handler = connectMatch[2];
    const extraArgs = connectMatch[3] || '';

    const sender = extractSender(extraArgs);

    connections.push({
      signal,
      handler,
      sender: sender ?? undefined,
      line: i + 1,
    });
  }

  return connections;
}

/** Extract sender= value from argument string. */
function extractSender(argsStr: string): string | null {
  // sender=ModelName or sender='app.ModelName'
  const senderMatch = argsStr.match(/sender\s*=\s*(?:['"]([^'"]+)['"]|(\w+))/);
  if (!senderMatch) return null;
  const raw = senderMatch[1] ?? senderMatch[2];
  // Normalize 'app.Model' to 'Model'
  return raw.includes('.') ? raw.split('.').pop()! : raw;
}

/** Extract signal name(s) from the first argument. */
function extractSignalNames(argsStr: string): string[] {
  // Remove sender=... and anything after it for parsing the signal part
  const signalPart = argsStr.replace(/,?\s*sender\s*=\s*(?:['"][^'"]+['"]|\w+)/, '').trim();

  // List of signals: [post_save, post_delete]
  const listMatch = signalPart.match(/^\[([^\]]+)\]/);
  if (listMatch) {
    return listMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(normalizeSignalName);
  }

  // Single signal: post_save or signals.post_save
  const singleMatch = signalPart.match(/^(?:signals?\.)?(\w+)/);
  if (singleMatch) return [normalizeSignalName(singleMatch[0])];

  return [];
}

/** Normalize signal name by stripping 'signals.' prefix. */
function normalizeSignalName(name: string): string {
  return name.replace(/^signals?\./, '').trim();
}
