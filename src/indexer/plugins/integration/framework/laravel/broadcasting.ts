/**
 * Laravel Broadcasting / Reverb extraction.
 *
 * Extends the event graph with:
 * - Events implementing ShouldBroadcast → broadcastOn() channel list
 * - broadcastAs() custom event name
 * - broadcastWith() payload field list
 * - routes/channels.php → Broadcast::channel() authorization callbacks
 */
import type { RawEdge } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

interface BroadcastingEventInfo {
  className: string;
  namespace: string;
  fqn: string;
  channels: BroadcastChannel[];
  /** Custom broadcast name from broadcastAs() */
  broadcastAs: string | null;
  /** Payload fields from broadcastWith() */
  payloadFields: string[];
}

interface BroadcastChannel {
  /** Channel name / pattern (may contain variables: 'orders.{userId}') */
  name: string;
  type: 'public' | 'private' | 'presence';
}

interface ChannelAuthMapping {
  /** Channel name pattern e.g. 'orders.{userId}' */
  pattern: string;
  /** FQN of authorization class, or 'closure' */
  authClass: string;
}

// ─── Detection ────────────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const USE_STMT_RE = /use\s+([\w\\]+?)(?:\s+as\s+(\w+))?;/g;

const IMPLEMENTS_BROADCAST_RE = /class\s+\w+[^{]*implements[^{]*ShouldBroadcast(?:Now)?\b/;

// ─── Event extraction ─────────────────────────────────────────

export function extractBroadcastingEvent(
  source: string,
  _filePath: string,
): BroadcastingEventInfo | null {
  if (!IMPLEMENTS_BROADCAST_RE.test(source)) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const channels = extractChannels(source, useMap);
  const broadcastAs = extractBroadcastAs(source);
  const payloadFields = extractPayloadFields(source);

  return { className, namespace, fqn, channels, broadcastAs, payloadFields };
}

// ─── Channel authorization extraction (routes/channels.php) ──

export function extractChannelAuthorizations(source: string): ChannelAuthMapping[] {
  const results: ChannelAuthMapping[] = [];
  const useMap = buildUseMap(source);

  // Broadcast::channel('pattern', function(...) {...})
  // Broadcast::channel('pattern', ChannelClass::class)
  const re = /Broadcast::channel\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const pattern = match[1];
    const handler = match[2].trim();

    let authClass: string;
    if (handler.startsWith('function') || handler.includes('=>')) {
      authClass = 'closure';
    } else {
      // ChannelClass::class or just ChannelClass
      const classMatch = handler.match(/([\w\\]+)(?:::class)?/);
      authClass = classMatch ? resolveClass(classMatch[1], useMap) : 'closure';
    }

    results.push({ pattern, authClass });
  }

  return results;
}

// ─── Edge builders ────────────────────────────────────────────

function buildBroadcastingEdges(event: BroadcastingEventInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const channel of event.channels) {
    edges.push({
      edgeType: 'broadcasts_on',
      metadata: {
        sourceFqn: event.fqn,
        channelName: channel.name,
        channelType: channel.type,
        broadcastAs: event.broadcastAs,
        payload: event.payloadFields,
      },
    });
  }

  return edges;
}

function buildChannelAuthEdges(mappings: ChannelAuthMapping[]): RawEdge[] {
  return mappings.map((m) => ({
    edgeType: 'broadcast_authorized_by',
    metadata: { channelPattern: m.pattern, authClass: m.authClass },
  }));
}

// ─── Internal helpers ─────────────────────────────────────────

function buildUseMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(USE_STMT_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const fqn = match[1];
    const alias = match[2] ?? fqn.split('\\').pop()!;
    map.set(alias, fqn);
  }
  return map;
}

function resolveClass(ref: string, useMap: Map<string, string>): string {
  const clean = ref.startsWith('\\') ? ref.slice(1) : ref;
  if (clean.includes('\\')) return clean;
  return useMap.get(clean) ?? clean;
}

function extractChannels(source: string, _useMap: Map<string, string>): BroadcastChannel[] {
  const channels: BroadcastChannel[] = [];

  // Find broadcastOn() method body
  const methodMatch = source.match(/function\s+broadcastOn\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s*\}/);
  if (!methodMatch) return channels;

  const body = methodMatch[1];

  // new PrivateChannel('name') / new Channel('name') / new PresenceChannel('name')
  const re = /new\s+(Private|Presence)?Channel\(\s*['"]([\w.{}_-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const qualifier = match[1];
    const name = match[2];
    const type: BroadcastChannel['type'] =
      qualifier === 'Private' ? 'private' : qualifier === 'Presence' ? 'presence' : 'public';
    channels.push({ name, type });
  }

  // Also handle string concatenation: 'orders.' . $this->order->user_id
  // Extract just the base pattern
  const concatRe = /new\s+(Private|Presence)?Channel\(\s*['"]([^'"]+)['"]\s*\./g;
  while ((match = concatRe.exec(body)) !== null) {
    const qualifier = match[1];
    const baseName = match[2] + '{id}'; // simplified pattern
    const type: BroadcastChannel['type'] =
      qualifier === 'Private' ? 'private' : qualifier === 'Presence' ? 'presence' : 'public';
    // Only add if not already captured
    if (!channels.some((c) => c.name.startsWith(match![2]))) {
      channels.push({ name: baseName, type });
    }
  }

  return channels;
}

function extractBroadcastAs(source: string): string | null {
  const match = source.match(
    /function\s+broadcastAs\s*\([^)]*\)[^{]*\{[^}]*return\s*['"]([^'"]+)['"]/,
  );
  return match?.[1] ?? null;
}

function extractPayloadFields(source: string): string[] {
  const fields: string[] = [];

  // broadcastWith() return ['field1' => ..., 'field2' => ...]
  const methodMatch = source.match(/function\s+broadcastWith\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s*\}/);
  if (!methodMatch) return fields;

  const body = methodMatch[1];
  const re = /['"](\w+)['"]\s*=>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    fields.push(match[1]);
  }

  return fields;
}
