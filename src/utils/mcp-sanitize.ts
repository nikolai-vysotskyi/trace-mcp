/**
 * MCP response sanitization — defends agents that consume our tool output
 * against prompt-injection delivered through indexed source code.
 *
 * The threat: a malicious file (or one carelessly committed) can embed
 * synthetic conversation framing in a comment, docstring, or string literal
 * (faked closing tags for system / tool_use / tool_result blocks, U+2028 /
 * U+2029 line separators that some JSON parsers treat as newlines, raw C0
 * control bytes that pollute terminals or break serializers). When our tools
 * return source code, signatures, or surrounding context to an LLM client,
 * those payloads could escape the structured envelope.
 *
 * The defenses:
 *  1. Strip C0 control characters except \t \n \r — they are never legitimate
 *     in source we want the model to read, and they break terminal output and
 *     some JSON consumers.
 *  2. Replace U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR with \n —
 *     historic JSON-vs-JS-string-literal mismatch.
 *  3. Defang the closing form of well-known agent framing tokens by inserting
 *     a zero-width space. The text remains visually identical and code that
 *     legitimately mentions the tag (e.g. doc comments about prompt injection)
 *     stays readable; the model just no longer parses it as a real boundary.
 *
 * This is a final-line-of-defense layer. The primary sanitization should be
 * "treat tool output as untrusted" on the consumer side, but cheap server-side
 * scrubbing closes the most obvious holes.
 *
 * Note on this file: the framing tokens are assembled at runtime from
 * fragments so this source file does not itself contain literal closing-tag
 * payloads (which would otherwise reappear in our own get_symbol / get_outline
 * output and require sanitization to remove themselves).
 */

const ZWSP = '​'; // zero-width space — invisible, breaks token match
const LSEP = ' '; // U+2028 LINE SEPARATOR
const PSEP = ' '; // U+2029 PARAGRAPH SEPARATOR

/**
 * Tag *bodies* (without surrounding `<` `/` `>`) whose closing form, if echoed
 * verbatim into a model context, can fool the consumer into thinking our tool
 * output ended early. We only neutralize the closing form, so legitimate uses
 * of the opening tag in code stay untouched and we keep false positives down.
 */
const FRAMING_TAG_BODIES: ReadonlyArray<string> = [
  'system',
  'tool_use',
  'tool_result',
  'tool_call',
  'function_calls',
  'antml:function_calls',
  'antml:parameter',
  'antml:invoke',
];

/** Pre-built defanged replacements: `</tag>` → `</ta​g>` (visually same). */
const FRAMING_REPLACEMENTS: ReadonlyArray<{ from: string; to: string }> = FRAMING_TAG_BODIES.map(
  (body) => {
    const open = '<' + '/';
    const close = '>';
    const head = body.slice(0, 2);
    const tail = body.slice(2);
    return {
      from: open + body + close,
      to: open + head + ZWSP + tail + close,
    };
  },
);

/**
 * Sanitize a single string for inclusion in an MCP tool response. Cheap —
 * O(n) scan with simple replacements.
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;

  // Quick path: if no suspicious chars and no framing tokens, return as-is.
  let needsCleanup = false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      needsCleanup = true;
      break;
    }
    if (code === 0x7f || code === 0x2028 || code === 0x2029) {
      needsCleanup = true;
      break;
    }
  }

  let out = input;
  if (needsCleanup) {
    // Strip C0 except \t \n \r and DEL (0x7f).
    out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    // Map U+2028 / U+2029 to \n.
    out = out.replace(new RegExp(LSEP, 'g'), '\n').replace(new RegExp(PSEP, 'g'), '\n');
  }

  // Always run the framing-tag defang — string scan is fast and false
  // positives are visually invisible, so the cost of being defensive is low.
  for (const { from, to } of FRAMING_REPLACEMENTS) {
    if (out.includes(from)) {
      out = out.split(from).join(to);
    }
  }

  return out;
}

/**
 * Recursively sanitize every string field reachable from `value`. Arrays and
 * plain objects are walked in place where possible, but we always return a
 * fresh value so callers do not need to worry about mutation aliasing.
 *
 * Non-string scalars (numbers, booleans, null, undefined), Buffers, Maps,
 * Sets, and class instances are passed through unchanged — only POJOs and
 * arrays are traversed. This matches the shape of our tool result payloads,
 * which are always JSON-serializable plain data.
 *
 * `maxDepth` exists so a pathological self-referential structure cannot trap
 * the sanitizer; default 64 is well above any real tool response depth.
 */
export function sanitizeValue<T>(value: T, maxDepth = 64): T {
  return sanitizeInner(value, maxDepth) as T;
}

function sanitizeInner(value: unknown, depth: number): unknown {
  if (depth <= 0) return value;
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = sanitizeInner(value[i], depth - 1);
    }
    return out;
  }

  // Skip non-POJO objects (Buffers, Maps, Sets, class instances). Their
  // serialization shape is the caller's responsibility; we only traverse
  // structures the JSON path naturally produces.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeInner(v, depth - 1);
  }
  return out;
}
