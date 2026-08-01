/**
 * FilterBar — shared match / exclude / depth control row.
 *
 * Stateless / controlled: parent owns `value`, FilterBar renders inputs and
 * calls `onChange` with the next value. Per-keystroke updates are debounced
 * (200ms) inside the bar so consumers receive stable values without having to
 * implement their own debouncing.
 *
 * Match/Exclude inputs accept either:
 *   - plain text → case-insensitive substring
 *   - /pattern/i → JavaScript regex (the trailing flags are optional;
 *     when absent the bar always evaluates with the `i` flag)
 *
 * When a regex is detected the input shows a small "regex" badge so the user
 * knows the alternate semantics are active. An invalid regex flips the badge
 * to red but the value is still propagated — the consumer decides how to
 * handle a broken pattern (typically by treating it as substring fallback).
 *
 * Depth is a numeric stepper (1..10). When the consumer sets `depthEnabled`
 * to false the control is hidden entirely. Depth meaning is left to the
 * consumer (BFS hops, tree levels, etc.) — the bar just clamps and reports.
 *
 * Persistence: pass `storageKey` to remember the last value across reloads.
 * The bar reads from localStorage on mount (overriding the initial `value`
 * prop ONLY on first render) and writes back on every change.
 */

import { useEffect, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────

export interface FilterValue {
  /** Match pattern. Empty string = no match filter. */
  match: string;
  /** Exclude pattern. Empty string = no exclude filter. */
  exclude: string;
  /** Depth limit. null = unlimited (∞). Range 1..10 when set. */
  depth: number | null;
}

export interface FilterBarProps {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  /** Show the depth stepper. Default true. */
  depthEnabled?: boolean;
  /** Custom placeholders for the two text inputs. */
  placeholder?: {
    match?: string;
    exclude?: string;
  };
  /**
   * If set, last-used values are persisted under this key in localStorage.
   * Hydrated once on mount (overriding `value`); each change writes back.
   */
  storageKey?: string;
  /** Optional extra classes for the wrapper. */
  className?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 200;
const DEPTH_MIN = 1;
const DEPTH_MAX = 10;

const REGEX_FORM = /^\/(.+)\/([gimsuy]*)$/;

/** True when the input is shaped like `/pattern/flags`. */
function isRegexLiteral(input: string): boolean {
  return REGEX_FORM.test(input);
}

/**
 * Try to compile the input as a regex. Returns `null` when invalid.
 * Plain text inputs are NOT compiled — caller treats them as substrings.
 * Always forces case-insensitive matching when the user omitted the `i` flag.
 */
function tryCompileRegex(input: string): RegExp | null {
  const m = input.match(REGEX_FORM);
  if (!m) return null;
  const [, body, flags] = m;
  const finalFlags = flags.includes('i') ? flags : `${flags}i`;
  try {
    return new RegExp(body, finalFlags);
  } catch {
    return null;
  }
}

/**
 * Evaluate whether `text` matches `pattern`. Empty pattern → always true.
 * - regex literal → regex test
 * - plain text   → case-insensitive substring
 * Invalid regex falls back to substring on the body between the slashes.
 */
export function matchesFilter(text: string, pattern: string): boolean {
  if (!pattern) return true;
  if (isRegexLiteral(pattern)) {
    const re = tryCompileRegex(pattern);
    if (re) return re.test(text);
    // Broken pattern: fall back to substring on the body so partial typing
    // (e.g. user is mid-edit) still narrows results predictably.
    const body = pattern.slice(1, pattern.lastIndexOf('/'));
    return text.toLowerCase().includes(body.toLowerCase());
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}

interface PersistedShape {
  match?: unknown;
  exclude?: unknown;
  depth?: unknown;
}

function readPersisted(key: string): Partial<FilterValue> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedShape;
    const result: Partial<FilterValue> = {};
    if (typeof parsed.match === 'string') result.match = parsed.match;
    if (typeof parsed.exclude === 'string') result.exclude = parsed.exclude;
    if (parsed.depth === null) {
      result.depth = null;
    } else if (typeof parsed.depth === 'number' && Number.isFinite(parsed.depth)) {
      result.depth = clampDepth(parsed.depth);
    }
    return result;
  } catch {
    return null;
  }
}

function writePersisted(key: string, value: FilterValue): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / privacy mode — non-fatal */
  }
}

function clampDepth(n: number): number {
  if (!Number.isFinite(n)) return DEPTH_MIN;
  return Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, Math.round(n)));
}

// ── Subcomponents ─────────────────────────────────────────────────────────

interface ModeBadgeProps {
  pattern: string;
}

/**
 * Small "regex" pill shown next to a match/exclude input when the value is
 * shaped like `/.../`. Turns red when the regex fails to compile.
 */
function ModeBadge({ pattern }: ModeBadgeProps) {
  if (!isRegexLiteral(pattern)) return null;
  const valid = tryCompileRegex(pattern) !== null;
  const color = valid ? '#60a5fa' : '#f87171';
  const bg = valid ? 'rgba(96,165,250,0.15)' : 'rgba(248,113,113,0.15)';
  return (
    <span
      className="text-[9px] px-1 py-0.5 rounded font-medium uppercase shrink-0 leading-none"
      style={{
        background: bg,
        color,
        letterSpacing: '0.04em',
      }}
      title={valid ? 'Regex mode' : 'Invalid regex (substring fallback)'}
    >
      regex
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function FilterBar({
  value,
  onChange,
  depthEnabled = true,
  placeholder,
  storageKey,
  className,
}: FilterBarProps) {
  // Local mirror of the parent value — this is what the inputs are bound to,
  // so typing feels instant even though the debounced version is what flows
  // back upstream via onChange.
  const [local, setLocal] = useState<FilterValue>(value);

  // Hydrate from localStorage exactly once on mount. We deliberately bypass
  // the debounce timer for hydration so the first onChange the parent sees
  // reflects the persisted state before any user interaction.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (!storageKey) return;
    const persisted = readPersisted(storageKey);
    if (!persisted) return;
    const merged: FilterValue = {
      match: persisted.match ?? value.match,
      exclude: persisted.exclude ?? value.exclude,
      depth: persisted.depth !== undefined ? persisted.depth : value.depth,
    };
    setLocal(merged);
    onChange(merged);
    // Intentionally do not depend on `value` / `onChange` — hydration is a
    // one-shot mount effect and re-running it would clobber subsequent edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Keep local state in sync if the parent forces a new value (e.g. a Reset
  // button). Skip on the very first effect to avoid stomping the hydration
  // pass that may have just queued an onChange the parent hasn't applied yet.
  const lastParentRef = useRef(value);
  useEffect(() => {
    if (lastParentRef.current === value) return;
    lastParentRef.current = value;
    setLocal(value);
  }, [value]);

  // Debounced upstream propagation. We watch local; on any change, schedule
  // an onChange + persist after DEBOUNCE_MS of quiescence. Cancelling the
  // timer on rapid edits is what gives the input its calm-feeling rhythm.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Suppress no-op emissions to keep parent re-renders cheap.
      if (
        local.match === value.match &&
        local.exclude === value.exclude &&
        local.depth === value.depth
      ) {
        return;
      }
      onChange(local);
      if (storageKey) writePersisted(storageKey, local);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // We intentionally exclude `value` and `onChange` from deps — both are
    // identity-unstable from the parent and would defeat the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, storageKey]);

  // ── Input handlers ───────────────────────────────────────────────────
  const setMatch = (next: string) => setLocal((prev) => ({ ...prev, match: next }));
  const setExclude = (next: string) => setLocal((prev) => ({ ...prev, exclude: next }));
  const setDepth = (next: number | null) =>
    setLocal((prev) => ({
      ...prev,
      depth: next === null ? null : clampDepth(next),
    }));

  // ── Styling tokens ───────────────────────────────────────────────────
  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-inset)',
    border: '0.5px solid var(--border-row)',
    borderRadius: 6,
    color: 'var(--text-primary)',
    fontSize: 12,
    padding: '4px 8px',
    outline: 'none',
    width: '100%',
  };

  const labelStyle: React.CSSProperties = {
    color: 'var(--text-tertiary)',
    fontSize: 10,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    fontWeight: 500,
  };

  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      {/* Match */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span style={labelStyle} className="shrink-0">Match</span>
        <div className="relative flex-1 min-w-0 flex items-center gap-1.5">
          <input
            type="text"
            value={local.match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder={placeholder?.match ?? 'substring or /regex/i'}
            style={inputStyle}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <ModeBadge pattern={local.match} />
        </div>
      </div>

      {/* Exclude */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span style={labelStyle} className="shrink-0">Exclude</span>
        <div className="relative flex-1 min-w-0 flex items-center gap-1.5">
          <input
            type="text"
            value={local.exclude}
            onChange={(e) => setExclude(e.target.value)}
            placeholder={placeholder?.exclude ?? 'substring or /regex/i'}
            style={inputStyle}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <ModeBadge pattern={local.exclude} />
        </div>
      </div>

      {/* Depth */}
      {depthEnabled && (
        <div className="flex items-center gap-1.5 shrink-0">
          <span style={labelStyle}>Depth</span>
          <div
            className="flex items-center"
            style={{
              background: 'var(--bg-inset)',
              border: '0.5px solid var(--border-row)',
              borderRadius: 6,
              height: 26,
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (local.depth === null) {
                  setDepth(DEPTH_MAX);
                } else if (local.depth <= DEPTH_MIN) {
                  setDepth(null);
                } else {
                  setDepth(local.depth - 1);
                }
              }}
              className="px-1.5 text-[12px] leading-none"
              style={{
                color: 'var(--text-secondary)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                height: '100%',
              }}
              title="Decrease depth (or set to ∞)"
              aria-label="Decrease depth"
            >
              −
            </button>
            <span
              className="px-1.5 text-[12px] tabular-nums select-none"
              style={{
                color: 'var(--text-primary)',
                minWidth: 18,
                textAlign: 'center',
              }}
              title={local.depth === null ? 'Unlimited depth' : `Depth limit: ${local.depth}`}
            >
              {local.depth === null ? '∞' : local.depth}
            </span>
            <button
              type="button"
              onClick={() =>
                setDepth(local.depth === null ? DEPTH_MIN : Math.min(DEPTH_MAX, local.depth + 1))
              }
              className="px-1.5 text-[12px] leading-none"
              style={{
                color: 'var(--text-secondary)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                height: '100%',
              }}
              title="Increase depth"
              aria-label="Increase depth"
            >
              +
            </button>
          </div>
          {local.depth !== null && (
            <button
              type="button"
              onClick={() => setDepth(null)}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: 'transparent',
                color: 'var(--text-tertiary)',
                border: '0.5px solid var(--border-row)',
                cursor: 'pointer',
              }}
              title="Reset to unlimited"
            >
              ∞
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Default value — convenience for consumers wiring the bar from scratch. */
export const EMPTY_FILTER_VALUE: FilterValue = {
  match: '',
  exclude: '',
  depth: null,
};
