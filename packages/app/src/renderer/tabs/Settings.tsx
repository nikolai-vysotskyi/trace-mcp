/**
 * Settings — the menu window's configuration surface (TRA-295).
 *
 * Layout:
 *   Toolbar  — 52px glass row: a back button when a section is open, the screen
 *              title, the search field, and an overflow menu that holds the
 *              raw-config escape hatch. Nothing here is accent-filled.
 *   Content  — inset grouped lists capped at a readable measure, each group
 *              under an 11px caption.
 *   Bottom   — the unsaved-changes bar, scoped to this pane rather than fixed
 *              across the whole window (it used to run under the sidebar too).
 *
 * What this replaces, measured on the running app before the rewrite:
 *   - Seven unlabelled groups. macOS settings groups carry titles; these now do.
 *   - `Edit JSON` as the single most prominent control on the screen — an
 *     accent-filled button for a raw-config escape hatch. It is a menu item.
 *   - A 7px blue dot as the only signal that a section differs from its
 *     defaults, with no legend anywhere. It is the word "Modified".
 *   - `PID 64806 · Port 3741 · 22s` as the daemon card's headline. The state
 *     leads; the PID moved behind "Copy daemon details".
 *   - Title Case section names (`Quality Gates`, `Ignore Rules`, `Tool
 *     Exposure`, `Per-project Overrides`) — sentence case throughout now.
 *   - A 928px-wide, 28px-tall, 7px-radius grey search rectangle — the
 *     SearchField primitive, in the toolbar where a search field belongs.
 *   - A `?` tooltip glyph that was a 14px non-focusable span: field help is a
 *     caption under the label, readable without a hover.
 *   - The `lsp` section, which existed in the schema and was silently dropped
 *     because it belonged to no group and groups are what the list renders.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OllamaPanel } from '../components/OllamaPanel';
import { localeOptions, t, useLocale } from '../i18n';
import { Icon } from '../lattice/icons';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  Menu,
  MenuItem,
  MenuSeparator,
  PopUpButton,
  SearchField,
  StatusDot,
  Toolbar,
  useMenuAnchor,
} from '../lattice/ui';
import { useDaemon } from '../hooks/useDaemon';
import { type Appearance, appearanceOptions } from '../theme.js';
import {
  CONFIG_SCHEMA,
  computeDiff,
  countModifiedFields,
  type DiffEntry,
  type FieldDef,
  getSectionDefaults,
  isFieldVisible,
  type SectionDef,
  validateField,
  validateSection,
} from './configSchema';

/* ═══ Helpers ═════════════════════════════════════════════════════════ */

function formatUptime(s: number) {
  if (s < 60) return t('settings:uptime.seconds', { value: Math.floor(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t('settings:uptime.minutes', { value: m });
  const h = Math.floor(m / 60);
  return m % 60 > 0
    ? t('settings:uptime.hoursMinutes', { hours: h, minutes: m % 60 })
    : t('settings:uptime.hours', { value: h });
}

function gv(d: Record<string, unknown>, f: FieldDef): unknown {
  if (f.nested) {
    const p = d[f.nested];
    return p && typeof p === 'object' ? (p as Record<string, unknown>)[f.key] : undefined;
  }
  return d[f.key];
}

function sv(d: Record<string, unknown>, f: FieldDef, v: unknown): Record<string, unknown> { // i18n-exempt: a type signature, not prose
  const c = { ...d };
  if (f.nested) {
    const p =
      c[f.nested] && typeof c[f.nested] === 'object'
        ? { ...(c[f.nested] as Record<string, unknown>) }
        : {};
    if (v !== undefined) p[f.key] = v;
    else delete p[f.key];
    c[f.nested] = Object.keys(p).length ? p : undefined;
  } else if (v !== undefined) c[f.key] = v;
  else delete c[f.key];
  return c;
}

function sd(cfg: Record<string, unknown>, sec: SectionDef): Record<string, unknown> { // i18n-exempt: a type signature, not prose
  if (sec.key === '_root') {
    const r: Record<string, unknown> = {};
    for (const f of sec.fields) if (f.key in cfg) r[f.key] = cfg[f.key];
    return r;
  }
  const v = cfg[sec.key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* Groups carry titles — macOS System Settings has no unlabelled group, and
   seven of them in a row read as one undifferentiated list. `lsp` is in
   Infrastructure: a section that belongs to no group never renders at all. */
/* `title` is a catalogue key, resolved where the group renders. */
const SECTION_GROUPS: { title: string; keys: string[] }[] = [
  { title: 'settings:group.general', keys: ['_root'] },
  { title: 'settings:group.intelligence', keys: ['ai', 'predictive', 'intent'] },
  { title: 'settings:group.quality', keys: ['security', 'quality_gates', 'ignore'] },
  { title: 'settings:group.infrastructure', keys: ['runtime', 'topology', 'lsp'] },
  { title: 'settings:group.development', keys: ['tools', 'frameworks'] },
  { title: 'settings:group.monitoring', keys: ['logging', 'watch'] },
];

/* ═══ Layout primitives ═══════════════════════════════════════════════
   The same three shapes the other migrated surfaces use: a captioned Section,
   an opaque Card with hairline separators, and 36px rows. */

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && (
        <h3
          className="px-1 min-h-6 flex items-center text-[11px] leading-[13px] font-semibold"
          style={{ color: 'var(--label-secondary)' }}
        >
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden"
      style={{
        background: 'var(--surface)',
        borderRadius: 12,
        border: '0.5px solid var(--separator)',
      }}
    >
      {children}
    </div>
  );
}

const rowBorder = (last: boolean): string => (last ? 'none' : '0.5px solid var(--separator)');

/* ═══ Toggle (38×22 — the AppKit switch size) ═════════════════════════ */

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      style={{
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 11,
        padding: 0,
        background: on ? 'var(--accent-fill)' : 'var(--fill-tertiary)',
        border: 'none',
        cursor: 'default',
        transition: 'background var(--dur-standard) var(--ease-out)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          width: 18,
          height: 18,
          borderRadius: 9,
          left: on ? 18 : 2,
          /* The AppKit switch knob is white in BOTH appearances, so this is the
             one place --accent-contrast is right regardless of the track. */
          background: 'var(--accent-contrast)',
          boxShadow: '0 1px 2px rgb(0 0 0 / 0.2), 0 0 0 0.5px rgb(0 0 0 / 0.04)',
          transition: 'left var(--dur-standard) var(--ease-out)',
        }}
      />
    </button>
  );
}

/* ═══ Right chevron ══════════════════════════════════════════════════ */
/* Decoration next to a labelled row, so --label-tertiary is correct here. */
function ChevronRight() {
  return (
    <span style={{ display: 'flex', color: 'var(--label-tertiary)', flexShrink: 0 }}>
      <Icon name="chevron_right" size={14} />
    </span>
  );
}

/* ═══ Field controls ═════════════════════════════════════════════════ */

const inputBase: React.CSSProperties = {
  fontSize: 13,
  fontFamily: 'inherit',
  height: 24,
  padding: '0 8px',
  borderRadius: 'var(--radius-input)',
  border: '0.5px solid var(--separator)',
  background: 'var(--fill-quaternary)',
  color: 'var(--label)',
};

function FieldControl({
  field,
  value,
  onChange,
  onOpenPicker,
  sectionData,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenPicker?: () => void;
  sectionData?: Record<string, unknown>;
}) {
  const err = validateField(field, value);
  const errS = err ? { borderColor: 'var(--status-red)' } : {};
  const hint = err ? (
    <div
      className="text-[11px] leading-[13px] mt-1"
      style={{ color: 'var(--status-red)' }}
      role="alert"
    >
      {err}
    </div>
  ) : null;

  switch (field.type) {
    case 'boolean':
      return <Toggle on={!!value} onChange={(v) => onChange(v)} label={t(field.label)} />;
    case 'select':
      return (
        <button
          type="button"
          onClick={onOpenPicker}
          aria-label={
            (value as string)
              ? t('settings:field.aria', { label: t(field.label), value: value as string })
              : t('settings:field.ariaUnset', { label: t(field.label) })
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            minHeight: 24,
            background: 'none',
            border: 'none',
            cursor: 'default',
            padding: 0,
            fontSize: 13,
            color: 'var(--label-secondary)',
          }}
        >
          {(value as string) || t('settings:notSet')}
          <ChevronRight />
        </button>
      );
    case 'number':
      return (
        <div>
          <input
            type="number"
            value={value != null ? String(value) : ''}
            placeholder={field.placeholder}
            aria-label={t(field.label)}
            min={field.min}
            max={field.max}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v === '' ? undefined : Number(v));
            }}
            style={{ ...inputBase, ...errS, width: 80, textAlign: 'right' }}
          />
          {hint}
        </div>
      );
    case 'string':
      return (
        <div style={{ flex: 1, minWidth: 0, maxWidth: 180 }}>
          <input
            type={field.sensitive ? 'password' : 'text'}
            value={(value as string) ?? ''}
            placeholder={field.placeholder}
            aria-label={t(field.label)}
            onChange={(e) => onChange(e.target.value || undefined)}
            style={{ ...inputBase, ...errS, width: '100%', textAlign: 'right' }}
          />
          {hint}
        </div>
      );
    case 'multiselect':
      return <MultiselectCtrl field={field} value={value} onChange={onChange} />;
    case 'model-select':
      return (
        <ModelSelectCtrl
          field={field}
          value={value}
          sectionData={sectionData ?? {}}
          onChange={onChange}
        />
      );
    case 'array':
      return (
        <ArrayCtrl
          value={value as string[] | undefined}
          label={t(field.label)}
          placeholder={field.placeholder}
          onChange={onChange}
        />
      );
    case 'json':
      return <JsonCtrl value={value} label={t(field.label)} onChange={onChange} />;
    default:
      return null;
  }
}

function ArrayCtrl({
  value,
  label,
  placeholder,
  onChange,
}: {
  value: string[] | undefined;
  label: string;
  placeholder?: string;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => (value ?? []).join(', '));
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const items = text
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        onChange(items.length ? items : undefined);
      }}
      style={{ ...inputBase, width: '100%', textAlign: 'left' }}
    />
  );
}

function JsonCtrl({
  value,
  label,
  onChange,
}: {
  value: unknown;
  label: string;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => (value != null ? JSON.stringify(value, null, 2) : ''));
  const [error, setError] = useState(false);
  return (
    <div style={{ width: '100%' }}>
      <textarea
        value={text}
        aria-label={label}
        rows={3}
        onChange={(e) => {
          setText(e.target.value);
          setError(false);
        }}
        onBlur={() => {
          if (!text.trim()) {
            setError(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(text));
            setError(false);
          } catch {
            setError(true);
          }
        }}
        style={{
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          width: '100%',
          padding: 8,
          borderRadius: 'var(--radius-input)',
          resize: 'vertical',
          border: `0.5px solid ${error ? 'var(--status-red)' : 'var(--separator)'}`,
          background: 'var(--fill-quaternary)',
          color: 'var(--label)',
        }}
      />
      {error && (
        <div
          className="text-[11px] leading-[13px] mt-1"
          style={{ color: 'var(--status-red)' }}
          role="alert"
        >
          {t('settings:invalidJson')}
        </div>
      )}
    </div>
  );
}

/* ═══ Multiselect ═══════════════════════════════════════════════════ */

function MultiselectCtrl({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
  const options = field.options ?? [];
  const toggle = (opt: string) => {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(next.size > 0 ? [...next] : undefined);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <Chip key={opt} label={opt} selected={selected.has(opt)} onClick={() => toggle(opt)} />
      ))}
    </div>
  );
}

/* ═══ Model select (fetch models from provider) ════════════════════ */

interface ModelOption {
  name: string;
  size?: string;
}

/** Default base URLs for all providers (used when base_url field is empty). */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; label: string }> = {
  ollama: { baseUrl: 'http://localhost:11434', label: 'Ollama' }, // i18n-exempt
  lmstudio: { baseUrl: 'http://localhost:1234/v1', label: 'LM Studio' }, // i18n-exempt
  openai: { baseUrl: 'https://api.openai.com', label: 'OpenAI' },
  anthropic: { baseUrl: 'https://api.anthropic.com', label: 'Anthropic' }, // i18n-exempt
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    label: 'Gemini (Google Generative Language API)', // i18n-exempt
  },
  vertex: { baseUrl: 'https://aiplatform.googleapis.com', label: 'Google Vertex AI' }, // i18n-exempt
  voyage: { baseUrl: 'https://api.voyageai.com/v1', label: 'Voyage AI' }, // i18n-exempt
  mistral: { baseUrl: 'https://api.mistral.ai/v1', label: 'Mistral' }, // i18n-exempt
  groq: { baseUrl: 'https://api.groq.com/openai/v1', label: 'Groq' }, // i18n-exempt
  together: { baseUrl: 'https://api.together.xyz/v1', label: 'Together' }, // i18n-exempt
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', label: 'DeepSeek' },
  xai: { baseUrl: 'https://api.x.ai/v1', label: 'xAI' },
};

/** Providers that use the OpenAI-compatible /v1/models endpoint. */
const OPENAI_COMPAT_PROVIDERS = new Set([
  'openai',
  'lmstudio',
  'mistral',
  'groq',
  'together',
  'deepseek',
  'xai',
]);

/** Anthropic models (no list API — static list of current models). */
const ANTHROPIC_MODELS: ModelOption[] = [
  { name: 'claude-opus-4-20250514' },
  { name: 'claude-sonnet-4-20250514' },
  { name: 'claude-haiku-4-5-20251001' },
];

async function fetchOpenAICompatModels(
  url: string,
  key: string,
  label: string,
  signal: AbortSignal,
): Promise<ModelOption[]> {
  const endpoint = `${url.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(endpoint, { signal, headers });
  if (!res.ok)
    throw new Error(
      t(res.status === 401 ? 'settings:models.authError' : 'settings:models.httpError', {
        provider: label,
        status: res.status,
      }),
    );
  const data = (await res.json()) as { data?: { id: string }[] };
  const list: ModelOption[] = (data.data ?? []).map((m) => ({ name: m.id }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function useProviderModels(
  provider: string | undefined,
  baseUrl: string | undefined,
  apiKey: string | undefined,
): {
  models: ModelOption[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchModels = useCallback(async () => {
    if (!provider || provider === 'onnx') {
      setModels([]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);

    const defaults = PROVIDER_DEFAULTS[provider];
    const label = defaults?.label ?? provider;
    const key = apiKey || '';

    try {
      // ── Ollama: custom /api/tags endpoint ──
      if (provider === 'ollama') {
        const url = (baseUrl || defaults?.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
        const res = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
        if (!res.ok)
          throw new Error(t('settings:models.httpError', { provider: 'Ollama', status: res.status }));
        const data = (await res.json()) as {
          models?: { name?: string; model?: string; size?: number }[];
        };
        const list: ModelOption[] = (data.models ?? []).map((m) => ({
          name: m.name ?? m.model ?? '',
          size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : undefined,
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        if (!ctrl.signal.aborted) setModels(list);
      }
      // ── Anthropic: static list (no models API) ──
      else if (provider === 'anthropic') {
        setModels(ANTHROPIC_MODELS);
      }
      // ── Gemini: Google AI REST API ──
      else if (provider === 'gemini') {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
          { signal: ctrl.signal },
        );
        if (!res.ok)
          throw new Error(
            t(res.status === 400 ? 'settings:models.authError' : 'settings:models.httpError', {
              provider: 'Gemini',
              status: res.status,
            }),
          );
        const data = (await res.json()) as { models?: { name?: string }[] };
        const list: ModelOption[] = (data.models ?? []).map((m) => ({
          name: (m.name ?? '').replace(/^models\//, ''),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        if (!ctrl.signal.aborted) setModels(list);
      }
      // ── All OpenAI-compatible providers ──
      else if (OPENAI_COMPAT_PROVIDERS.has(provider)) {
        const url = baseUrl || defaults?.baseUrl || '';
        const list = await fetchOpenAICompatModels(
          url.replace(/\/+$/, ''),
          key,
          label,
          ctrl.signal,
        );
        if (!ctrl.signal.aborted) setModels(list);
      }
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError' && !ctrl.signal.aborted)
        setError(err.message ?? t('settings:models.failed'));
    } finally {
      // Aborted means either a newer fetch superseded this one or the component
      // unmounted — either way this run owns no state any more. Without the
      // guard the settle lands after teardown and React touches a gone `window`.
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [provider, baseUrl, apiKey]);

  useEffect(() => {
    fetchModels();
    return () => abortRef.current?.abort();
  }, [fetchModels]);

  return { models, loading, error, refresh: fetchModels };
}

function ModelSelectCtrl({
  field,
  value,
  sectionData,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  sectionData: Record<string, unknown>;
  onChange: (v: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const provider = field.modelProvider ? String(sectionData[field.modelProvider] ?? '') : undefined;
  const baseUrl = field.modelBaseUrlField
    ? (sectionData[field.modelBaseUrlField] as string | undefined)
    : undefined;
  const apiKey = sectionData.api_key as string | undefined;
  const { models, loading, error, refresh } = useProviderModels(provider, baseUrl, apiKey);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = (value as string) ?? '';

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = filter
    ? models.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()))
    : models;

  const optionRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    minHeight: 28,
    padding: '0 10px',
    border: 'none',
    cursor: 'default',
    textAlign: 'left',
    fontSize: 13,
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          current
            ? t('settings:field.aria', { label: t(field.label), value: current })
            : t('settings:field.ariaUnset', { label: t(field.label) })
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minHeight: 24,
          background: 'none',
          border: 'none',
          cursor: 'default',
          padding: 0,
          maxWidth: 180,
          fontSize: 13,
          color: 'var(--label-secondary)',
        }}
      >
        <span className="truncate">
          {current || field.placeholder || t('settings:models.select')}
        </span>
        <span style={{ display: 'flex', color: 'var(--label-tertiary)', flexShrink: 0 }}>
          <Icon name={open ? 'expand_less' : 'expand_more'} size={14} />
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t(field.label)}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            zIndex: 200,
            width: 260,
            maxHeight: 280,
            background: 'var(--surface)',
            borderRadius: 'var(--radius-popover)',
            border: '0.5px solid var(--separator)',
            boxShadow: 'var(--shadow-panel)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ padding: 8, borderBottom: '0.5px solid var(--separator)' }}>
            <SearchField
              grow
              autoFocus
              value={filter}
              onChange={setFilter}
              placeholder={t('settings:models.filter')}
              aria-label={t('settings:models.filter')}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 200 }}>
            {loading && (
              <div
                className="text-[13px] leading-4 text-center"
                style={{ padding: 12, color: 'var(--label-secondary)' }}
                role="status"
              >
                {t('settings:models.loading')}
              </div>
            )}
            {error && (
              <div style={{ padding: 8 }}>
                <div
                  className="text-[11px] leading-[13px] mb-1.5"
                  style={{ color: 'var(--status-red)' }}
                  role="alert"
                >
                  {error}
                </div>
                <Button size="small" onClick={refresh}>
                  {t('settings:models.retry')}
                </Button>
              </div>
            )}
            {!loading && !error && filtered.length === 0 && (
              <div
                className="text-[13px] leading-4 text-center"
                style={{ padding: 12, color: 'var(--label-secondary)' }}
              >
                {models.length === 0 ? t('settings:models.none') : t('settings:models.noMatches')}
              </div>
            )}
            {!loading && !error && current && (
              <button
                type="button"
                onClick={() => {
                  onChange(undefined);
                  setOpen(false);
                  setFilter('');
                }}
                style={{
                  ...optionRow,
                  background: 'none',
                  borderBottom: '0.5px solid var(--separator)',
                  color: 'var(--label-secondary)',
                }}
              >
                {t('settings:models.clear')}
              </button>
            )}
            {filtered.map((m) => (
              <button
                type="button"
                key={m.name}
                role="option"
                aria-selected={m.name === current}
                onClick={() => {
                  onChange(m.name);
                  setOpen(false);
                  setFilter('');
                }}
                style={{
                  ...optionRow,
                  color: 'var(--label)',
                  background:
                    m.name === current
                      ? 'color-mix(in oklab, var(--accent) 12%, transparent)'
                      : 'none',
                }}
              >
                <span className="flex-1 truncate">{m.name}</span>
                {m.size && (
                  <span
                    className="text-[11px] tabular-nums shrink-0"
                    style={{ color: 'var(--label-secondary)' }}
                  >
                    {m.size}
                  </span>
                )}
                {m.name === current && (
                  <span style={{ display: 'flex', color: 'var(--accent)', flexShrink: 0 }}>
                    <Icon name="check" size={14} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div style={{ padding: 8, borderTop: '0.5px solid var(--separator)' }}>
            <input
              type="text"
              placeholder={t('settings:models.type')}
              aria-label={t('settings:models.typeAria')}
              defaultValue=""
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const v = (e.target as HTMLInputElement).value.trim();
                if (!v) return;
                onChange(v);
                setOpen(false);
                setFilter('');
              }}
              style={{ ...inputBase, width: '100%', textAlign: 'left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══ Screen: Section list ═══════════════════════════════════════════ */

function SectionList({
  sections,
  config,
  onOpen,
  onOpenProjects,
  projectOverrides,
  search,
}: {
  sections: SectionDef[];
  config: Record<string, unknown>;
  onOpen: (key: string) => void;
  onOpenProjects: () => void;
  projectOverrides: number;
  search: string;
}) {
  const sectionMap = new Map(sections.map((s) => [s.key, s]));

  const renderRow = (section: SectionDef, isLast: boolean) => {
    const data = sd(config, section);
    const modified = countModifiedFields(section, data);
    const errors = Object.keys(validateSection(section, data)).length;

    return (
      <button
        type="button"
        key={section.key}
        onClick={() => onOpen(section.key)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: 36,
          padding: '0 12px',
          background: 'none',
          border: 'none',
          borderBottom: rowBorder(isLast),
          cursor: 'default',
          textAlign: 'left',
        }}
      >
        <span className="flex-1 text-[13px] leading-4" style={{ color: 'var(--label)' }}>
          {t(section.label)}
        </span>
        {errors > 0 ? (
          <Badge tone="red">{t('settings:issues', { count: errors })}</Badge>
        ) : modified > 0 ? (
          /* The blue dot this replaces was a colour with no legend anywhere in
             the app. The word says what the colour meant. */
          <span className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
            {t('settings:modified')}
          </span>
        ) : null}
        <ChevronRight />
      </button>
    );
  };

  const visibleGroups = SECTION_GROUPS.map((g) => ({
    title: g.title,
    sections: g.keys.map((k) => sectionMap.get(k)).filter((s): s is SectionDef => s !== undefined),
  })).filter((g) => g.sections.length > 0);

  const showProjects = !search || t('settings:projects.title').toLowerCase().includes(search);

  if (visibleGroups.length === 0 && !showProjects) {
    return (
      <p
        className="text-[13px] leading-4 text-center"
        style={{ padding: 24, color: 'var(--label-secondary)', margin: 0 }}
      >
        {t('settings:noMatches', { query: search })}
      </p>
    );
  }

  return (
    <>
      {visibleGroups.map((group) => (
        <Section key={group.title} title={t(group.title)}>
          <Card>{group.sections.map((s, i) => renderRow(s, i === group.sections.length - 1))}</Card>
        </Section>
      ))}

      {showProjects && (
        <Section title={t('settings:group.advanced')}>
          <Card>
            <button
              type="button"
              onClick={onOpenProjects}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 36,
                padding: '0 12px',
                background: 'none',
                border: 'none',
                cursor: 'default',
                textAlign: 'left',
              }}
            >
              <span className="flex-1 text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                {t('settings:projects.title')}
              </span>
              {projectOverrides > 0 && (
                <span
                  className="text-[11px] leading-[13px] tabular-nums"
                  style={{ color: 'var(--label-secondary)' }}
                >
                  {projectOverrides}
                </span>
              )}
              <ChevronRight />
            </button>
          </Card>
        </Section>
      )}
    </>
  );
}

/* ═══ Screen: Section detail ═════════════════════════════════════════ */

interface PickerInfo {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}

function SectionDetail({
  section,
  data,
  onUpdate,
  onOpenPicker,
}: {
  section: SectionDef;
  data: Record<string, unknown>;
  onUpdate: (k: string, d: Record<string, unknown>) => void;
  onOpenPicker: (p: PickerInfo) => void;
}) {
  const modified = countModifiedFields(section, data);
  const visible = section.fields.filter((f) => isFieldVisible(f, data));

  return (
    <>
      {section.description && (
        <p
          className="text-[13px] leading-4 px-1 -mb-2"
          style={{ color: 'var(--label-secondary)', margin: 0 }}
        >
          {t(section.description)}
        </p>
      )}

      <Card>
        {visible.map((field, i) => {
          const value = gv(data, field);
          const hasDef = field.defaultValue !== undefined;
          const isSet = value !== undefined && value !== null && value !== '';
          /* An unset field IS at its default — the daemon applies the default
             when the key is absent. Comparing `undefined` against the default
             put a Reset button on almost every row (TRA-295). */
          const isModified =
            hasDef && isSet && JSON.stringify(value) !== JSON.stringify(field.defaultValue);
          const isBlock =
            field.type === 'json' || field.type === 'array' || field.type === 'multiselect';
          const changeFn = (v: unknown) => onUpdate(section.key, sv(data, field, v));
          const showReset = isModified || (!hasDef && isSet);

          return (
            <div
              key={`${field.nested ?? ''}.${field.key}.${field.showIf ?? ''}`}
              style={{
                padding: isBlock ? '8px 12px' : '6px 12px',
                borderBottom: rowBorder(i === visible.length - 1),
              }}
            >
              <div
                className="flex items-center justify-between gap-3"
                style={{ minHeight: 24 }}
              >
                <div className="min-w-0 flex-1">
                  {/* The nested key used to be printed inline at label size —
                      "features.Use embeddings" reads as a typo, and the section
                      the row lives in already scopes it. */}
                  <div className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                    {t(field.label)}
                  </div>
                  {/* Help is a caption, not a hover: the `?` glyph it replaces
                      was a 14px non-focusable span, so keyboard users never
                      reached it and pointer users had to guess it existed. */}
                  {field.description && (
                    <div
                      className="text-[11px] leading-[13px] mt-0.5"
                      style={{ color: 'var(--label-secondary)' }}
                    >
                      {t(field.description)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {showReset && (
                    <Button size="small" variant="plain" onClick={() => changeFn(field.defaultValue)}>
                      {t('settings:reset')}
                    </Button>
                  )}
                  {!isBlock && (
                    <FieldControl
                      field={field}
                      value={value}
                      onChange={changeFn}
                      sectionData={data}
                      onOpenPicker={
                        field.type === 'select'
                          ? () => onOpenPicker({ field, value, onChange: changeFn })
                          : undefined
                      }
                    />
                  )}
                </div>
              </div>
              {isBlock && (
                <div className="mt-2">
                  <FieldControl
                    field={field}
                    value={value}
                    onChange={changeFn}
                    sectionData={data}
                  />
                </div>
              )}
            </div>
          );
        })}
      </Card>

      {modified > 0 && (
        <div className="flex justify-center">
          {/* Bordered, not plain: centred plain text with no chrome reads as a
              caption, and this one throws away the section's settings. */}
          <Button onClick={() => onUpdate(section.key, getSectionDefaults(section))}>
            {t('settings:resetSection')}
          </Button>
        </div>
      )}

      {/* AI Activity — link out to the Activity tab (which lives in project windows). */}
      {section.key === 'ai' && <ActivityLink />}

      {/* Ollama control — shown when the AI section is open and provider is ollama */}
      {section.key === 'ai' && data.provider === 'ollama' && (
        <OllamaPanel baseUrl={typeof data.base_url === 'string' ? data.base_url : undefined} />
      )}
    </>
  );
}

/* ═══ Screen: Picker (select options) ════════════════════════════════ */

function PickerScreen({ picker, onBack }: { picker: PickerInfo; onBack: () => void }) {
  const options = picker.field.options ?? [];
  const row = (isLast: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    minHeight: 36,
    padding: '0 12px',
    background: 'none',
    border: 'none',
    borderBottom: rowBorder(isLast),
    cursor: 'default',
    textAlign: 'left',
  });
  const check = (
    <span style={{ display: 'flex', color: 'var(--accent)' }}>
      <Icon name="check" size={15} />
    </span>
  );

  return (
    <Card>
      <button
        type="button"
        role="option"
        aria-selected={picker.value == null || picker.value === ''}
        onClick={() => {
          picker.onChange(undefined);
          onBack();
        }}
        style={row(false)}
      >
        <span className="flex-1 text-[13px] leading-4" style={{ color: 'var(--label-secondary)' }}>
          {t('settings:notSet')}
        </span>
        {(picker.value == null || picker.value === '') && check}
      </button>
      {options.map((opt, i) => (
        <button
          type="button"
          key={opt}
          role="option"
          aria-selected={picker.value === opt}
          onClick={() => {
            picker.onChange(opt);
            onBack();
          }}
          style={row(i === options.length - 1)}
        >
          <span className="flex-1 text-[13px] leading-4" style={{ color: 'var(--label)' }}>
            {opt}
          </span>
          {picker.value === opt && check}
        </button>
      ))}
    </Card>
  );
}

/* ═══ Screen: Per-project overrides ══════════════════════════════════ */

function ProjectsScreen({
  config,
  onUpdate,
}: {
  config: Record<string, unknown>;
  onUpdate: (c: Record<string, unknown>) => void;
}) {
  const projects = (config.projects ?? {}) as Record<string, unknown>;
  const [newPath, setNewPath] = useState('');
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editJson, setEditJson] = useState('');
  const [editError, setEditError] = useState(false);
  const paths = Object.keys(projects);

  const add = () => {
    const p = newPath.trim();
    if (!p) return;
    onUpdate({ ...config, projects: { ...projects, [p]: {} } });
    setEditKey(p);
    setEditJson('{}');
    setNewPath('');
  };

  return (
    <>
      <p
        className="text-[13px] leading-4 px-1 -mb-2"
        style={{ color: 'var(--label-secondary)', margin: 0 }}
      >
        {t('settings:projects.intro')}
      </p>

      {paths.length > 0 && (
        <Card>
          {paths.map((p, i) => (
            <div key={p} style={{ padding: '8px 12px', borderBottom: rowBorder(i === paths.length - 1) }}>
              <div className="flex items-center gap-2">
                <span
                  className="flex-1 min-w-0 truncate text-[13px] leading-4"
                  style={{ fontFamily: 'var(--font-mono)', color: 'var(--label)' }}
                  title={p}
                >
                  {p}
                </span>
                <Button
                  size="small"
                  active={editKey === p}
                  aria-expanded={editKey === p}
                  onClick={() => {
                    if (editKey === p) {
                      setEditKey(null);
                      return;
                    }
                    setEditKey(p);
                    setEditJson(JSON.stringify(projects[p], null, 2));
                    setEditError(false);
                  }}
                >
                  {editKey === p ? t('settings:projects.done') : t('settings:projects.edit')}
                </Button>
                <Button
                  size="small"
                  variant="plain"
                  onClick={() => {
                    const u = { ...projects };
                    delete u[p];
                    onUpdate({ ...config, projects: u });
                    if (editKey === p) setEditKey(null);
                  }}
                >
                  {t('settings:projects.remove')}
                </Button>
              </div>
              {editKey === p && (
                <div className="mt-2">
                  <textarea
                    value={editJson}
                    aria-label={t('settings:projects.overridesAria', { path: p })}
                    rows={4}
                    onChange={(e) => {
                      setEditJson(e.target.value);
                      setEditError(false);
                    }}
                    style={{
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                      width: '100%',
                      padding: 8,
                      borderRadius: 'var(--radius-input)',
                      resize: 'vertical',
                      border: `0.5px solid ${editError ? 'var(--status-red)' : 'var(--separator)'}`,
                      background: 'var(--fill-quaternary)',
                      color: 'var(--label)',
                    }}
                  />
                  {editError && (
                    <div
                      className="text-[11px] leading-[13px] mt-1"
                      style={{ color: 'var(--status-red)' }}
                      role="alert"
                    >
                      {t('settings:invalidJson')}
                    </div>
                  )}
                  <div className="mt-2">
                    <Button
                      size="small"
                      onClick={() => {
                        try {
                          onUpdate({
                            ...config,
                            projects: { ...projects, [p]: JSON.parse(editJson) },
                          });
                          setEditError(false);
                        } catch {
                          setEditError(true);
                        }
                      }}
                    >
                      {t('settings:projects.apply')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newPath}
          placeholder="/path/to/project"
          aria-label={t('settings:projects.pathAria')}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          style={{ ...inputBase, flex: 1 }}
        />
        <Button disabled={!newPath.trim()} onClick={add}>
          {t('settings:projects.add')}
        </Button>
      </div>
    </>
  );
}

/* ═══ Diff panel ═════════════════════════════════════════════════════ */

function DiffPanel({ entries, onClose }: { entries: DiffEntry[]; onClose: () => void }) {
  if (!entries.length) return null;
  return (
    <Section title={t('settings:diff.title')}>
      <Card>
        <div className="flex items-center justify-end px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--separator)' }}>
          <Button size="small" variant="plain" onClick={onClose}>
            {t('settings:diff.hide')}
          </Button>
        </div>
        <div style={{ maxHeight: 160, overflowY: 'auto' }}>
          {entries.map((e, i) => (
            <div
              key={`${e.section}.${e.field}`}
              className="flex items-baseline gap-1.5 px-3 py-1 text-[11px] leading-[13px]"
              style={{
                fontFamily: 'var(--font-mono)',
                borderBottom: rowBorder(i === entries.length - 1),
              }}
            >
              <span className="shrink-0" style={{ color: 'var(--label-secondary)' }}>
                {e.section}
              </span>
              <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--label)' }}>
                {e.field}
              </span>
              <span className="shrink-0" style={{ color: 'var(--status-red)' }}>
                {fmt(e.from)}
              </span>
              <span style={{ color: 'var(--label-secondary)' }}>→</span>
              <span className="shrink-0" style={{ color: 'var(--status-green)' }}>
                {fmt(e.to)}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </Section>
  );
}

/* ═══ Bottom bar ═════════════════════════════════════════════════════ */

function BottomBar({
  dirty,
  saving,
  hasErrors,
  diffCount,
  showDiff,
  onToggleDiff,
  onSave,
  onDiscard,
  saveStatus,
}: {
  dirty: boolean;
  saving: boolean;
  hasErrors: boolean;
  diffCount: number;
  showDiff: boolean;
  onToggleDiff: () => void;
  onSave: () => void;
  onDiscard: () => void;
  saveStatus: 'idle' | 'saved' | 'error';
}) {
  if (!dirty) return null;
  const msg = hasErrors
    ? t('settings:bar.hasErrors')
    : saveStatus === 'saved'
      ? t('settings:bar.saved')
      : saveStatus === 'error'
        ? t('settings:bar.saveFailed')
        : t('settings:bar.unsaved', { count: diffCount });
  return (
    /* Scoped to this pane. The old bar was `position: fixed` across the whole
       window, so it ran under the sidebar as well. */
    <div
      className="flex items-center gap-2 px-4 shrink-0 glass"
      role="status"
      style={{ height: 52, borderTop: '0.5px solid var(--separator)' }}
    >
      <span
        className="flex-1 min-w-0 truncate text-[13px] leading-4"
        style={{
          color: hasErrors
            ? 'var(--status-red)'
            : saveStatus === 'saved'
              ? 'var(--status-green)'
              : 'var(--label-secondary)',
        }}
      >
        {msg}
      </span>
      {diffCount > 0 && !hasErrors && (
        <Button variant="plain" active={showDiff} onClick={onToggleDiff}>
          {showDiff ? t('settings:bar.hideChanges') : t('settings:bar.reviewChanges')}
        </Button>
      )}
      <Button onClick={onDiscard}>{t('settings:bar.discard')}</Button>
      <Button variant="prominent" disabled={saving || hasErrors} onClick={onSave}>
        {saving ? t('settings:bar.saving') : t('settings:bar.save')}
      </Button>
    </div>
  );
}

/* The app's own preferences — Theme and Language — as opposed to the daemon's
   configuration in every group below. That is why it is its own group above the
   schema-driven list rather than a section inside it, and why it is headed
   "App" against the "Daemon" card directly above: the group used to be headed
   "Appearance" over a single "Theme" row, which worked only while Theme was the
   only thing in it. A heading that repeats its one row's label is weight
   without information, and "General" is already the first schema group on this
   same screen (TRA-388).

   Theme moved here from the sidebar footer, which was carrying two 28px rows
   under a 38px update banner (TRA-306). The card renders in the daemon-down and
   loading states too: both preferences live in localStorage and have nothing to
   do with the daemon, so losing the connection must not take them with it. */
function PrefRow({
  label,
  last,
  children,
}: {
  label: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2"
      style={{ minHeight: 36, padding: '0 12px', borderBottom: rowBorder(last ?? false) }}
    >
      <span className="flex-1 text-[13px] leading-4" style={{ color: 'var(--label)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function AppPrefsCard({
  appearance,
  onChange,
}: {
  appearance: Appearance;
  onChange: (next: Appearance) => void;
}) {
  const { locale, setLocale } = useLocale();
  return (
    <Section title={t('settings:app.title')}>
      <Card>
        {/* Each control's accessible name matches the visible label beside it —
            a name that disagrees with the label a sighted user reads out loud is
            a voice-control dead end (WCAG 2.5.3). "App" is the GROUP heading. */}
        <PrefRow label={t('settings:appearance.theme')}>
          <PopUpButton
            options={appearanceOptions()}
            value={appearance}
            onChange={onChange}
            aria-label={t('settings:appearance.theme')}
          />
        </PrefRow>
        {/* Full names here, not the menu row's two letters — a pop-up button has
            the width for them, and they are written in their own language. */}
        <PrefRow label={t('settings:app.language')} last>
          <PopUpButton
            options={localeOptions()}
            value={locale}
            onChange={setLocale}
            aria-label={t('settings:app.language')}
          />
        </PrefRow>
      </Card>
    </Section>
  );
}

/* ═══ Main ═══════════════════════════════════════════════════════════ */

type Screen =
  | { type: 'list' }
  | { type: 'section'; key: string }
  | { type: 'picker'; sectionKey: string; picker: PickerInfo }
  | { type: 'projects' };

export function Settings({
  appearance,
  onAppearanceChange,
}: {
  /* App-level preference, not a daemon config field: it lives in localStorage
     and is owned by useTheme() in App.tsx, which is what applies [data-theme].
     It is threaded in rather than read from a second useTheme() so both copies
     cannot disagree about what the user picked (TRA-306). */
  appearance: Appearance;
  onAppearanceChange: (next: Appearance) => void;
}) {
  /* One subscription for the whole pane: every string below resolves through
     the module-level `t`, and this is what re-renders the subtree — and with it
     every child — when the language changes. */
  useTranslation('settings');
  const { settings, loading, connected, restarting, restartDaemon, updateSettings } = useDaemon();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [local, setLocal] = useState<Record<string, unknown> | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [search, setSearch] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const overflow = useMenuAnchor();
  const [screen, setScreen] = useState<Screen>(() => {
    const section = new URLSearchParams(window.location.search).get('section');
    if (section && CONFIG_SCHEMA.some((s) => s.key === section)) {
      return { type: 'section', key: section };
    }
    return { type: 'list' };
  });

  const server = (settings?.settings as Record<string, unknown>) ?? {};
  const config = local ?? server;

  const update = useCallback(
    (key: string, data: Record<string, unknown>) => {
      setLocal((prev) => {
        const base = prev ?? (settings?.settings as Record<string, unknown>) ?? {};
        if (key === '_root') {
          const u = { ...base };
          for (const [k, v] of Object.entries(data)) {
            if (v !== undefined) u[k] = v;
            else delete u[k];
          }
          return u;
        }
        return { ...base, [key]: data };
      });
      setDirty(true);
      setSaveStatus('idle');
    },
    [settings],
  );

  const updateFull = useCallback((c: Record<string, unknown>) => {
    setLocal(c);
    setDirty(true);
    setSaveStatus('idle');
  }, []);

  const save = useCallback(async () => {
    if (!local) return;
    setSaving(true);
    try {
      await updateSettings(local);
      setDirty(false);
      setSaveStatus('saved');
      setShowDiff(false);
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  }, [local, updateSettings]);

  const discard = useCallback(() => {
    setLocal(null);
    setDirty(false);
    setSaveStatus('idle');
    setShowDiff(false);
  }, []);

  const hasErrors = useMemo(
    () => CONFIG_SCHEMA.some((s) => Object.keys(validateSection(s, sd(config, s))).length > 0),
    [config],
  );
  const diffs = useMemo(() => (dirty ? computeDiff(server, config) : []), [dirty, server, config]);

  const q = search.toLowerCase().trim();
  /* Matched against the RENDERED wording, not the catalogue key: a Russian
     user searches in Russian. `f.key` stays in the match because it is the
     config field name they may have read in the JSON. */
  const matchSection = (s: SectionDef) => {
    if (!q) return true;
    const label = t(s.label).toLowerCase();
    const desc = s.description ? t(s.description).toLowerCase() : '';
    if (label.includes(q) || desc.includes(q)) return true;
    return s.fields.some(
      (f) =>
        t(f.label).toLowerCase().includes(q) ||
        f.key.toLowerCase().includes(q) ||
        (f.description ? t(f.description).toLowerCase().includes(q) : false),
    );
  };

  /* The toolbar owns the pane and always renders, so the daemon-down and
     loading states sit INSIDE the surface rather than replacing it. */
  if (!settings) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Toolbar>
          <h2
            className="text-[15px] leading-5 font-semibold"
            style={{ color: 'var(--label)', letterSpacing: '-0.01em' }}
          >
            {t('settings:title')}
          </h2>
        </Toolbar>
        <div className="flex-1 overflow-auto flex flex-col">
          <div className="px-4 pt-4 mx-auto w-full" style={{ maxWidth: 720 }}>
            <AppPrefsCard appearance={appearance} onChange={onAppearanceChange} />
          </div>
          <div className="flex-1 flex items-center justify-center">
          {/* A finished fetch that produced nothing is not still loading. The
              old code showed "Loading…" forever whenever the daemon answered
              once and then stopped, which is exactly what a flapping daemon
              does. */}
          {loading ? (
            <span
              className="text-[13px] leading-4"
              style={{ color: 'var(--label-secondary)' }}
              role="status"
            >
              {t('settings:empty.loading')}
            </span>
          ) : (
            <EmptyState
              icon="settings"
              title={t(
                connected ? 'settings:empty.unreadableTitle' : 'settings:empty.unreachableTitle',
              )}
              subtitle={t(
                connected ? 'settings:empty.unreadableBody' : 'settings:empty.unreachableBody',
              )}
              action={
                <Button variant="prominent" disabled={restarting} onClick={() => restartDaemon()}>
                  {restarting
                    ? t('settings:empty.starting')
                    : t(connected ? 'settings:empty.restart' : 'settings:empty.start')}
                </Button>
              }
            />
          )}
          </div>
        </div>
      </div>
    );
  }

  const { daemon } = settings;
  const filtered = CONFIG_SCHEMA.filter(matchSection);
  const activeSection =
    screen.type === 'section'
      ? CONFIG_SCHEMA.find((s) => s.key === screen.key)
      : screen.type === 'picker'
        ? CONFIG_SCHEMA.find((s) => s.key === screen.sectionKey)
        : undefined;

  const title =
    screen.type === 'list'
      ? t('settings:title')
      : screen.type === 'projects'
        ? t('settings:projects.title')
        : screen.type === 'picker'
          ? t(screen.picker.field.label)
          : t(activeSection?.label ?? 'settings:title');

  const back =
    screen.type === 'list'
      ? undefined
      : screen.type === 'picker'
        ? () => setScreen({ type: 'section', key: screen.sectionKey })
        : () => setScreen({ type: 'list' });

  const copyDaemonDetails = () => {
    /* Deliberately English in every language: this string exists to be pasted
       into a bug report, and a diagnostic that arrives translated is one the
       maintainer has to translate back. */
    const text = `trace-mcp daemon · PID ${daemon.pid} · port ${daemon.port} · up ${formatUptime(daemon.uptime)} · config ${settings.path}`;
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <Toolbar scrolled={scrolled} className="gap-3">
        {back && (
          <Button
            variant="icon"
            icon="chevron_left"
            onClick={back}
            aria-label={t('settings:back')}
            title={t('settings:back')}
          />
        )}
        <h2
          className="flex-1 min-w-0 text-[15px] leading-5 font-semibold truncate"
          style={{ color: 'var(--label)', letterSpacing: '-0.01em' }}
        >
          {title}
        </h2>
        {screen.type === 'list' && (
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('settings:search')}
            aria-label={t('settings:search')}
          />
        )}
        <Button
          ref={overflow.ref}
          variant="icon"
          icon="more_horiz"
          onClick={() => (overflow.at ? overflow.close() : overflow.open())}
          aria-haspopup="menu"
          aria-expanded={overflow.at !== null}
          aria-label={t('settings:moreActions')}
          title={t('settings:moreActions')}
        />
      </Toolbar>

      {overflow.at && (
        <Menu x={overflow.at.x} y={overflow.at.y} align="end" onClose={overflow.close}>
          <MenuItem
            icon="content_copy"
            onClick={() => {
              copyDaemonDetails();
              overflow.close();
            }}
          >
            {t('settings:copyDaemon')}
          </MenuItem>
          <MenuSeparator />
          {/* The raw-config escape hatch. It used to be the most prominent
              control on the screen; a hatch belongs behind a menu. */}
          <MenuItem
            icon="code"
            onClick={() => {
              window.electronAPI?.openInEditor?.(settings.path);
              overflow.close();
            }}
          >
            {t('settings:editConfigFile')}
          </MenuItem>
        </Menu>
      )}

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        <div className="flex flex-col gap-6 px-4 py-4 mx-auto w-full" style={{ maxWidth: 720 }}>
          {screen.type === 'list' && (
            <>
              {/* Daemon card — the STATE leads. The PID is diagnostic detail
                  and lives behind "Copy daemon details" in the overflow menu. */}
              <Card>
                <div className="flex items-center gap-2.5 px-3" style={{ minHeight: 44 }}>
                  <StatusDot tone="green" pulse title={t('settings:daemon.state')} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                      {t('settings:daemon.title')}
                    </div>
                    {/* One key, not a sentence assembled from spans: word order
                        moves between languages, so the numbers cannot be
                        positioned by the JSX. `tabular-nums` covers the line. */}
                    <div
                      className="text-[11px] leading-[13px] truncate tabular-nums"
                      style={{ color: 'var(--label-secondary)' }}
                    >
                      {t('settings:daemon.summary', {
                        port: daemon.port,
                        uptime: formatUptime(daemon.uptime),
                      })}
                    </div>
                  </div>
                </div>
              </Card>

              {/* Searchable by the group's name, by either row's label, and by
                  the language names themselves — someone looking for Russian
                  types "Рус", not "language". */}
              {(!q ||
                t('settings:app.title').toLowerCase().includes(q) ||
                t('settings:appearance.theme').toLowerCase().includes(q) ||
                t('settings:app.language').toLowerCase().includes(q) ||
                localeOptions().some((l) => l.label.toLowerCase().includes(q))) && (
                <AppPrefsCard appearance={appearance} onChange={onAppearanceChange} />
              )}

              <SectionList
                sections={filtered}
                config={config}
                onOpen={(key) => setScreen({ type: 'section', key })}
                onOpenProjects={() => setScreen({ type: 'projects' })}
                projectOverrides={Object.keys((config.projects ?? {}) as object).length}
                search={q}
              />
            </>
          )}

          {screen.type === 'section' &&
            (activeSection ? (
              <SectionDetail
                section={activeSection}
                data={sd(config, activeSection)}
                onUpdate={update}
                onOpenPicker={(p) =>
                  setScreen({ type: 'picker', sectionKey: screen.key, picker: p })
                }
              />
            ) : null)}

          {screen.type === 'picker' && (
            <PickerScreen
              picker={screen.picker}
              onBack={() => setScreen({ type: 'section', key: screen.sectionKey })}
            />
          )}

          {screen.type === 'projects' && <ProjectsScreen config={config} onUpdate={updateFull} />}

          {showDiff && <DiffPanel entries={diffs} onClose={() => setShowDiff(false)} />}
        </div>
      </div>

      <BottomBar
        dirty={dirty}
        saving={saving}
        hasErrors={hasErrors}
        diffCount={diffs.length}
        showDiff={showDiff}
        onToggleDiff={() => setShowDiff(!showDiff)}
        onSave={save}
        onDiscard={discard}
        saveStatus={saveStatus}
      />
    </div>
  );
}

/* ═══ ActivityLink ════════════════════════════════════════════════════
 *
 * Settings is rendered only in the global menu window (see App.tsx →
 * MenuContent). The Activity tab — including its "AI calls" sub-tab —
 * lives in project sub-windows (ProjectContent). There is no in-process
 * React state to flip across that boundary, and no IPC verb exists to
 * focus a specific tab inside an arbitrary project window from the menu
 * (electronAPI.openProjectTab only takes a project root). So we preset
 * the Activity sub-tab via localStorage and direct the user to a project
 * window manually.
 */
function ActivityLink() {
  /* The click's only effect is off-screen and in another window, so without
     this the button looked broken: pressed, nothing happened. */
  const [armed, setArmed] = useState(false);
  const onClick = useCallback(() => {
    try {
      localStorage.setItem('activity.subtab', 'ai');
      setArmed(true);
    } catch {
      /* ignore quota / disabled storage */
    }
  }, []);
  return (
    <Card>
      <div className="flex items-center gap-3 px-3" style={{ minHeight: 44 }}>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
            {t('settings:activity.title')}
          </div>
          <div
            className="text-[11px] leading-[13px] mt-0.5"
            style={{ color: armed ? 'var(--status-green)' : 'var(--label-secondary)' }}
          >
            {t(armed ? 'settings:activity.armed' : 'settings:activity.idle')}
          </div>
        </div>
        <Button disabled={armed} onClick={onClick}>
          {t(armed ? 'settings:activity.ready' : 'settings:activity.open')}
        </Button>
      </div>
    </Card>
  );
}
