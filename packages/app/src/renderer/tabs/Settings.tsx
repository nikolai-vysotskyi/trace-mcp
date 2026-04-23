import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { StatusDot } from '../components/StatusDot';
import { OllamaPanel } from '../components/OllamaPanel';
import { useDaemon } from '../hooks/useDaemon';
import {
  CONFIG_SCHEMA,
  validateField,
  validateSection,
  isFieldVisible,
  getSectionDefaults,
  countModifiedFields,
  computeDiff,
  type SectionDef,
  type FieldDef,
  type DiffEntry,
} from './configSchema';

/* ═══ Helpers ═════════════════════════════════════════════════════════ */

function formatUptime(s: number) {
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
}

function gv(d: Record<string, unknown>, f: FieldDef): unknown {
  if (f.nested) { const p = d[f.nested]; return p && typeof p === 'object' ? (p as any)[f.key] : undefined; }
  return d[f.key];
}

function sv(d: Record<string, unknown>, f: FieldDef, v: unknown): Record<string, unknown> {
  const c = { ...d };
  if (f.nested) {
    const p = c[f.nested] && typeof c[f.nested] === 'object' ? { ...(c[f.nested] as any) } : {};
    if (v !== undefined) p[f.key] = v; else delete p[f.key];
    c[f.nested] = Object.keys(p).length ? p : undefined;
  } else { if (v !== undefined) c[f.key] = v; else delete c[f.key]; }
  return c;
}

function sd(cfg: Record<string, unknown>, sec: SectionDef): Record<string, unknown> {
  if (sec.key === '_root') { const r: any = {}; for (const f of sec.fields) if (f.key in cfg) r[f.key] = cfg[f.key]; return r; }
  const v = cfg[sec.key]; return v && typeof v === 'object' && !Array.isArray(v) ? v as any : {};
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* No icon library — clean list like macOS (without icons looks better than fake icons) */

/* Section groups — semantic grouping like macOS System Settings */
const SECTION_GROUPS: string[][] = [
  ['_root'],                                          // General (alone)
  ['ai', 'predictive', 'intent'],                     // Intelligence
  ['security', 'quality_gates', 'ignore'],            // Quality & Security
  ['runtime', 'topology'],                            // Infrastructure
  ['tools', 'frameworks'],                            // Development
  ['logging', 'watch'],                               // Monitoring
];

/* ═══ Toggle (38×22) ══════════════════════════════════════════════════ */

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      style={{
        position: 'relative', width: 38, height: 22, borderRadius: 11, padding: 0,
        background: on ? 'var(--accent)' : 'var(--fill-toggle-off)',
        border: 'none', cursor: 'pointer', transition: 'background .2s ease', flexShrink: 0,
      }}>
      <span style={{
        position: 'absolute', top: 2, width: 18, height: 18, borderRadius: 9,
        left: on ? 18 : 2, background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.2), 0 0 0 .5px rgba(0,0,0,.04)',
        transition: 'left .2s cubic-bezier(.4,0,.2,1)',
      }} />
    </button>
  );
}

/* ═══ Back button ════════════════════════════════════════════════════ */

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 3,
        fontSize: 13, color: 'var(--accent)', background: 'none',
        border: 'none', cursor: 'pointer', padding: '0 0 10px', margin: 0,
      }}>
      <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
        <path d="M6 1L1 6L6 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}

/* ═══ Tooltip ═══════════════════════════════════════════════════════ */

function Tooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span style={{
        fontSize: 10, color: 'var(--text-tertiary)', width: 14, height: 14, borderRadius: 7,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-inset)', cursor: 'help', flexShrink: 0, fontWeight: 600,
      }}>?</span>
      {show && (
        <span style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 6, padding: '6px 10px', borderRadius: 6,
          background: 'var(--bg-popover, #1a1a1a)', color: 'var(--text-popover, #e0e0e0)',
          fontSize: 11, lineHeight: '15px', whiteSpace: 'normal', width: 220,
          boxShadow: '0 4px 12px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.08)',
          zIndex: 100, pointerEvents: 'none',
        }}>{text}</span>
      )}
    </span>
  );
}

/* ═══ Right chevron ══════════════════════════════════════════════════ */

function ChevronRight() {
  return (
    <svg width="7" height="12" viewBox="0 0 7 12" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1 1L6 6L1 11" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ═══ Grouped row ════════════════════════════════════════════════════ */

const inputBase: React.CSSProperties = {
  fontSize: 13, fontFamily: 'inherit', height: 22,
  padding: '0 6px', borderRadius: 5,
  border: '1px solid var(--border)', background: 'var(--fill-control)',
  color: 'var(--text-primary)', boxShadow: 'var(--shadow-control)',
};

function FieldControl({ field, value, onChange, onOpenPicker, sectionData }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; onOpenPicker?: () => void;
  sectionData?: Record<string, unknown>;
}) {
  const err = validateField(field, value);
  const errS = err ? { borderColor: 'var(--destructive)' } : {};
  const hint = err ? <div style={{ fontSize: 11, color: 'var(--destructive)', marginTop: 2 }}>{err}</div> : null;

  switch (field.type) {
    case 'boolean':
      return <Toggle on={!!value} onChange={v => onChange(v)} />;
    case 'select':
      return (
        <button type="button" onClick={onOpenPicker}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{(value as string) || '—'}</span>
          <ChevronRight />
        </button>
      );
    case 'number':
      return (<div>
        <input type="number" value={value != null ? String(value) : ''} placeholder={field.placeholder}
          min={field.min} max={field.max}
          onChange={e => { const v = e.target.value; onChange(v === '' ? undefined : Number(v)); }}
          style={{ ...inputBase, ...errS, width: 80, textAlign: 'right' }} />{hint}</div>);
    case 'string':
      return (<div style={{ flex: 1, minWidth: 0, maxWidth: 180 }}>
        <input type={field.sensitive ? 'password' : 'text'} value={(value as string) ?? ''}
          placeholder={field.placeholder} onChange={e => onChange(e.target.value || undefined)}
          style={{ ...inputBase, ...errS, width: '100%', textAlign: 'right' }} />{hint}</div>);
    case 'multiselect':
      return <MultiselectCtrl field={field} value={value} onChange={onChange} />;
    case 'model-select':
      return <ModelSelectCtrl field={field} value={value} sectionData={sectionData ?? {}} onChange={onChange} />;
    case 'array':
      return <ArrayCtrl value={value as string[] | undefined} placeholder={field.placeholder} onChange={onChange} />;
    case 'json':
      return <JsonCtrl value={value} placeholder={field.description} onChange={onChange} />;
    default: return null;
  }
}

function ArrayCtrl({ value, placeholder, onChange }: {
  value: string[] | undefined; placeholder?: string; onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => (value ?? []).join(', '));
  return <input type="text" value={text} placeholder={placeholder}
    onChange={e => setText(e.target.value)}
    onBlur={() => { const items = text.split(',').map(s => s.trim()).filter(Boolean); onChange(items.length ? items : undefined); }}
    style={{ ...inputBase, width: '100%', textAlign: 'left', height: 24 }} />;
}

function JsonCtrl({ value, placeholder, onChange }: {
  value: unknown; placeholder?: string; onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => value != null ? JSON.stringify(value, null, 2) : '');
  const [error, setError] = useState(false);
  return (<div style={{ width: '100%' }}>
    <textarea value={text} placeholder={placeholder} rows={3}
      onChange={e => { setText(e.target.value); setError(false); }}
      onBlur={() => { if (!text.trim()) { setError(false); onChange(undefined); return; }
        try { onChange(JSON.parse(text)); setError(false); } catch { setError(true); } }}
      style={{
        fontSize: 12, fontFamily: 'SF Mono, Menlo, monospace', width: '100%',
        padding: 6, borderRadius: 5, resize: 'vertical',
        border: `1px solid ${error ? 'var(--destructive)' : 'var(--border)'}`,
        background: 'var(--fill-control)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-control)',
      }} />
    {error && <div style={{ fontSize: 11, color: 'var(--destructive)', marginTop: 2 }}>Invalid JSON</div>}
  </div>);
}

/* ═══ Multiselect (checkbox list) ═══════════════════════════════════ */

function MultiselectCtrl({ field, value, onChange }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void;
}) {
  const selected = new Set(Array.isArray(value) ? value as string[] : []);
  const options = field.options ?? [];
  const toggle = (opt: string) => {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt); else next.add(opt);
    onChange(next.size > 0 ? [...next] : undefined);
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 0' }}>
      {options.map(opt => {
        const active = selected.has(opt);
        return (
          <button key={opt} type="button" onClick={() => toggle(opt)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--fill-control)',
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
              fontWeight: active ? 600 : 400, transition: 'all .15s ease',
            }}>
            {opt}
          </button>
        );
      })}
    </div>
  );
}

/* ═══ Model select (fetch models from provider) ════════════════════ */

interface ModelOption { name: string; size?: string; }

/** Default base URLs for all providers (used when base_url field is empty). */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; label: string }> = {
  ollama:   { baseUrl: 'http://localhost:11434', label: 'Ollama' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', label: 'LM Studio' },
  openai:   { baseUrl: 'https://api.openai.com', label: 'OpenAI' },
  anthropic: { baseUrl: 'https://api.anthropic.com', label: 'Anthropic' },
  gemini:   { baseUrl: 'https://generativelanguage.googleapis.com', label: 'Gemini (Google Generative Language API)' },
  vertex:   { baseUrl: 'https://aiplatform.googleapis.com', label: 'Google Vertex AI' },
  voyage:   { baseUrl: 'https://api.voyageai.com/v1', label: 'Voyage AI' },
  mistral:  { baseUrl: 'https://api.mistral.ai/v1', label: 'Mistral' },
  groq:     { baseUrl: 'https://api.groq.com/openai/v1', label: 'Groq' },
  together: { baseUrl: 'https://api.together.xyz/v1', label: 'Together' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', label: 'DeepSeek' },
  xai:      { baseUrl: 'https://api.x.ai/v1', label: 'xAI' },
};

/** Providers that use the OpenAI-compatible /v1/models endpoint. */
const OPENAI_COMPAT_PROVIDERS = new Set(['openai', 'lmstudio', 'mistral', 'groq', 'together', 'deepseek', 'xai']);

/** Anthropic models (no list API — static list of current models). */
const ANTHROPIC_MODELS: ModelOption[] = [
  { name: 'claude-opus-4-20250514' },
  { name: 'claude-sonnet-4-20250514' },
  { name: 'claude-haiku-4-5-20251001' },
];

async function fetchOpenAICompatModels(url: string, key: string, label: string, signal: AbortSignal): Promise<ModelOption[]> {
  const endpoint = `${url.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(endpoint, { signal, headers });
  if (!res.ok) throw new Error(`${label}: ${res.status}${res.status === 401 ? ' (check API key)' : ''}`);
  const data = await res.json();
  const list: ModelOption[] = (data.data ?? []).map((m: any) => ({ name: m.id }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function useProviderModels(provider: string | undefined, baseUrl: string | undefined, apiKey: string | undefined): {
  models: ModelOption[]; loading: boolean; error: string | null; refresh: () => void;
} {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchModels = useCallback(async () => {
    if (!provider || provider === 'onnx') { setModels([]); return; }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);

    const defaults = PROVIDER_DEFAULTS[provider];
    const label = defaults?.label ?? provider;
    const key = apiKey || '';

    try {
      // ── Ollama: custom /api/tags endpoint ──
      if (provider === 'ollama') {
        const url = (baseUrl || defaults?.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
        const res = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Ollama: ${res.status}`);
        const data = await res.json();
        const list: ModelOption[] = (data.models ?? []).map((m: any) => ({
          name: m.name ?? m.model,
          size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : undefined,
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setModels(list);
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
        if (!res.ok) throw new Error(`Gemini: ${res.status}${res.status === 400 ? ' (check API key)' : ''}`);
        const data = await res.json();
        const list: ModelOption[] = (data.models ?? []).map((m: any) => ({
          name: (m.name ?? '').replace(/^models\//, ''),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setModels(list);
      }
      // ── All OpenAI-compatible providers ──
      else if (OPENAI_COMPAT_PROVIDERS.has(provider)) {
        const url = baseUrl || defaults?.baseUrl || '';
        // LM Studio doesn't need an API key, others strip /v1 from baseUrl for fetch
        const resolvedUrl = url.replace(/\/+$/, '');
        // Ensure we have /v1 in the path for the models endpoint
        const modelsUrl = resolvedUrl.endsWith('/v1') ? resolvedUrl : resolvedUrl;
        setModels(await fetchOpenAICompatModels(modelsUrl, key, label, ctrl.signal));
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message ?? 'Failed to fetch models');
    } finally {
      setLoading(false);
    }
  }, [provider, baseUrl, apiKey]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  return { models, loading, error, refresh: fetchModels };
}

function ModelSelectCtrl({ field, value, sectionData, onChange }: {
  field: FieldDef; value: unknown; sectionData: Record<string, unknown>; onChange: (v: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const provider = field.modelProvider ? String(sectionData[field.modelProvider] ?? '') : undefined;
  const baseUrl = field.modelBaseUrlField ? (sectionData[field.modelBaseUrlField] as string | undefined) : undefined;
  const apiKey = sectionData['api_key'] as string | undefined;
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
    ? models.filter(m => m.name.toLowerCase().includes(filter.toLowerCase()))
    : models;

  return (
    <div ref={wrapRef} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'none', border: 'none', cursor: 'pointer', padding: 0, maxWidth: 180,
        }}>
        <span style={{
          fontSize: 13, color: current ? 'var(--text-secondary)' : 'var(--text-tertiary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{current || field.placeholder || 'Select model…'}</span>
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none" style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}>
          <path d="M1 1L4 4L7 1" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 200,
          width: 260, maxHeight: 280, background: 'var(--bg-popover, var(--bg-grouped))',
          borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.25), 0 0 0 .5px rgba(255,255,255,.08)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          {/* Search */}
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-row)' }}>
            <input type="text" value={filter} autoFocus placeholder="Filter models…"
              onChange={e => setFilter(e.target.value)}
              style={{ ...inputBase, width: '100%', height: 26, textAlign: 'left', fontSize: 12 }} />
          </div>
          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 200 }}>
            {loading && <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>Loading models…</div>}
            {error && (
              <div style={{ padding: '8px 10px', fontSize: 11 }}>
                <div style={{ color: 'var(--destructive)', marginBottom: 4 }}>{error}</div>
                <button type="button" onClick={refresh}
                  style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  Retry
                </button>
              </div>
            )}
            {!loading && !error && filtered.length === 0 && (
              <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
                {models.length === 0 ? 'No models found' : 'No matches'}
              </div>
            )}
            {/* Clear option */}
            {!loading && !error && current && (
              <button type="button" onClick={() => { onChange(undefined); setOpen(false); setFilter(''); }}
                style={{
                  display: 'flex', alignItems: 'center', width: '100%', padding: '6px 10px',
                  background: 'none', border: 'none', borderBottom: '1px solid var(--border-row)',
                  cursor: 'pointer', textAlign: 'left',
                }}>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>Clear selection</span>
              </button>
            )}
            {filtered.map(m => (
              <button type="button" key={m.name} onClick={() => { onChange(m.name); setOpen(false); setFilter(''); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 10px',
                  background: m.name === current ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'none',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  borderBottom: '1px solid var(--border-row)',
                }}>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                {m.size && <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>{m.size}</span>}
                {m.name === current && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M5 13l4 4L19 7" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))}
          </div>
          {/* Manual input fallback */}
          <div style={{
            padding: '6px 8px', borderTop: '1px solid var(--border-row)',
            display: 'flex', gap: 4, alignItems: 'center',
          }}>
            <input type="text" placeholder="Or type model name…" defaultValue=""
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) { onChange(v); setOpen(false); setFilter(''); }
                }
              }}
              style={{ ...inputBase, flex: 1, height: 24, textAlign: 'left', fontSize: 11 }} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══ Screen: Section list (top level) ═══════════════════════════════ */

function SectionList({ sections, config, onOpen, search }: {
  sections: SectionDef[]; config: Record<string, unknown>;
  onOpen: (key: string) => void; search: string;
}) {
  const sectionKeys = new Set(sections.map(s => s.key));
  const sectionMap = new Map(sections.map(s => [s.key, s]));

  const renderRow = (section: SectionDef, isLast: boolean) => {
    const data = sd(config, section);
    const modified = countModifiedFields(section, data);
    const errors = Object.keys(validateSection(section, data)).length;

    return (
      <button type="button" key={section.key}
        onClick={() => onOpen(section.key)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '8px 12px', background: 'none', border: 'none',
          borderBottom: isLast ? 'none' : '1px solid var(--border-row)',
          cursor: 'pointer', textAlign: 'left',
        }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 400, color: 'var(--text-primary)' }}>
          {section.label}
        </span>
        {errors > 0 && (
          <span style={{ fontSize: 11, color: 'var(--destructive)' }}>{errors}</span>
        )}
        {modified > 0 && !errors && (
          <span style={{
            width: 7, height: 7, borderRadius: 4, background: 'var(--accent)', flexShrink: 0,
          }} />
        )}
        <ChevronRight />
      </button>
    );
  };

  // Build visible groups: filter each group to only include sections matching search
  const visibleGroups = SECTION_GROUPS
    .map(group => group.filter(key => sectionKeys.has(key)).map(key => sectionMap.get(key)!))
    .filter(group => group.length > 0);

  return (
    <div>
      {visibleGroups.map((group, gi) => (
        <div key={gi} style={{
          background: 'var(--bg-grouped)', borderRadius: 10,
          boxShadow: 'var(--shadow-grouped)', overflow: 'hidden', marginBottom: 12,
        }}>
          {group.map((s, i) => renderRow(s, i === group.length - 1))}
        </div>
      ))}

      {search && !sections.length && (
        <p style={{ fontSize: 13, textAlign: 'center', padding: 24, color: 'var(--text-tertiary)', margin: 0 }}>
          No settings match &ldquo;{search}&rdquo;
        </p>
      )}
    </div>
  );
}

/* ═══ Screen: Section detail ═════════════════════════════════════════ */

interface PickerInfo { field: FieldDef; value: unknown; onChange: (v: unknown) => void; }

function SectionDetail({ section, data, onUpdate, onBack, onOpenPicker }: {
  section: SectionDef; data: Record<string, unknown>;
  onUpdate: (k: string, d: Record<string, unknown>) => void;
  onBack: () => void; onOpenPicker: (p: PickerInfo) => void;
}) {
  const modified = countModifiedFields(section, data);
  const visible = section.fields.filter(f => isFieldVisible(f, data));

  return (
    <div>
      <BackButton label="Settings" onClick={onBack} />

      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>
          {section.label}
        </div>
        {section.description && (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
            {section.description}
          </div>
        )}
      </div>

      {/* Fields */}
      <div style={{
        background: 'var(--bg-grouped)', borderRadius: 10,
        boxShadow: 'var(--shadow-grouped)', overflow: 'hidden',
      }}>
        {visible.map((field, i) => {
          const value = gv(data, field);
          const hasDef = field.defaultValue !== undefined;
          const isModified = hasDef && JSON.stringify(value) !== JSON.stringify(field.defaultValue);
          const isSet = value !== undefined && value !== null && value !== '';
          const isBlock = field.type === 'json' || field.type === 'array' || field.type === 'multiselect';
          const changeFn = (v: unknown) => onUpdate(section.key, sv(data, field, v));
          const showReset = isModified || (!hasDef && isSet);

          return (
            <div key={`${field.nested ?? ''}.${field.key}.${field.showIf ?? ''}`}
              style={{
                padding: '0 12px',
                borderBottom: i < visible.length - 1 ? '1px solid var(--border-row)' : 'none',
              }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, minHeight: 36, padding: isBlock ? '8px 0 4px' : '0',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                    {field.nested && <span style={{ color: 'var(--text-tertiary)' }}>{field.nested}.</span>}
                    {field.label}
                  </span>
                  {field.description && !isBlock && <Tooltip text={field.description} />}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {showReset && (
                    <button type="button" onClick={() => changeFn(field.defaultValue)}
                      style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, opacity: 0.7, flexShrink: 0 }}
                      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>
                      Reset
                    </button>
                  )}
                  {!isBlock && (
                    <FieldControl field={field} value={value} onChange={changeFn} sectionData={data}
                      onOpenPicker={field.type === 'select' ? () => onOpenPicker({ field, value, onChange: changeFn }) : undefined} />
                  )}
                </div>
              </div>
              {isBlock && (
                <div style={{ paddingBottom: 8 }}>
                  {field.description && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>{field.description}</div>}
                  <FieldControl field={field} value={value} onChange={changeFn} sectionData={data} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Reset all */}
      {modified > 0 && (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button type="button"
            onClick={() => onUpdate(section.key, getSectionDefaults(section))}
            style={{ fontSize: 13, color: 'var(--destructive)', background: 'none', border: 'none', cursor: 'pointer' }}>
            Reset All to Defaults
          </button>
        </div>
      )}

      {/* AI Activity — only on AI section */}
      {section.key === 'ai' && <AIActivity />}

      {/* Ollama control — shown when the AI section is open and provider is ollama */}
      {section.key === 'ai' && data.provider === 'ollama' && (
        <OllamaPanel baseUrl={typeof data.base_url === 'string' ? data.base_url : undefined} />
      )}
    </div>
  );
}

/* ═══ Screen: Picker (select options) ════════════════════════════════ */

function PickerScreen({ picker, sectionLabel, onBack }: {
  picker: PickerInfo; sectionLabel: string; onBack: () => void;
}) {
  const options = picker.field.options ?? [];
  return (
    <div>
      <BackButton label={sectionLabel} onClick={onBack} />
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
        {picker.field.label}
      </div>
      <div style={{
        background: 'var(--bg-grouped)', borderRadius: 10,
        boxShadow: 'var(--shadow-grouped)', overflow: 'hidden',
      }}>
        {/* None option */}
        <button type="button" onClick={() => { picker.onChange(undefined); onBack(); }}
          style={{
            display: 'flex', alignItems: 'center', width: '100%', padding: '0 12px', minHeight: 36,
            background: 'none', border: 'none', borderBottom: '1px solid var(--border-row)',
            cursor: 'pointer', textAlign: 'left',
          }}>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--text-tertiary)' }}>None</span>
          {(picker.value == null || picker.value === '') && (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        {options.map((opt, i) => (
          <button type="button" key={opt} onClick={() => { picker.onChange(opt); onBack(); }}
            style={{
              display: 'flex', alignItems: 'center', width: '100%', padding: '0 12px', minHeight: 36,
              background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
              borderBottom: i < options.length - 1 ? '1px solid var(--border-row)' : 'none',
            }}>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{opt}</span>
            {picker.value === opt && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ═══ Screen: Per-project overrides ══════════════════════════════════ */

function ProjectsScreen({ config, onUpdate, onBack }: {
  config: Record<string, unknown>; onUpdate: (c: Record<string, unknown>) => void; onBack: () => void;
}) {
  const projects = (config.projects ?? {}) as Record<string, unknown>;
  const [newPath, setNewPath] = useState('');
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editJson, setEditJson] = useState('');
  const [editError, setEditError] = useState(false);
  const paths = Object.keys(projects);

  const add = () => {
    const p = newPath.trim(); if (!p) return;
    onUpdate({ ...config, projects: { ...projects, [p]: {} } });
    setEditKey(p); setEditJson('{}'); setNewPath('');
  };

  return (
    <div>
      <BackButton label="Settings" onClick={onBack} />
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
        Per-project Overrides
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        Override global settings for specific projects. Values merge on top.
      </div>

      {paths.length > 0 && (
        <div style={{ background: 'var(--bg-grouped)', borderRadius: 10, boxShadow: 'var(--shadow-grouped)', overflow: 'hidden', marginBottom: 16 }}>
          {paths.map((p, i) => (
            <div key={p} style={{ padding: '8px 12px', borderBottom: i < paths.length - 1 ? '1px solid var(--border-row)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontFamily: 'SF Mono, Menlo, monospace', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{p}</span>
                <button type="button" onClick={() => {
                  if (editKey === p) setEditKey(null);
                  else { setEditKey(p); setEditJson(JSON.stringify(projects[p], null, 2)); setEditError(false); }
                }} style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {editKey === p ? 'Done' : 'Edit'}
                </button>
                <button type="button" onClick={() => {
                  const u = { ...projects }; delete u[p]; onUpdate({ ...config, projects: u });
                  if (editKey === p) setEditKey(null);
                }} style={{ fontSize: 12, color: 'var(--destructive)', background: 'none', border: 'none', cursor: 'pointer' }}>Remove</button>
              </div>
              {editKey === p && (
                <div style={{ marginTop: 6 }}>
                  <textarea value={editJson} rows={4}
                    onChange={e => { setEditJson(e.target.value); setEditError(false); }}
                    style={{
                      fontSize: 12, fontFamily: 'SF Mono, Menlo, monospace', width: '100%', padding: 6, borderRadius: 5, resize: 'vertical',
                      border: `1px solid ${editError ? 'var(--destructive)' : 'var(--border)'}`,
                      background: 'var(--fill-control)', color: 'var(--text-primary)',
                    }} />
                  {editError && <div style={{ fontSize: 11, color: 'var(--destructive)', marginTop: 2 }}>Invalid JSON</div>}
                  <button type="button" onClick={() => {
                    try { onUpdate({ ...config, projects: { ...projects, [p]: JSON.parse(editJson) } }); setEditError(false); }
                    catch { setEditError(true); }
                  }} style={{
                    marginTop: 6, fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--accent)',
                    border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
                  }}>Apply</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="text" value={newPath} placeholder="/path/to/project"
          onChange={e => setNewPath(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
          style={{ ...inputBase, flex: 1, height: 28 }} />
        <button type="button" onClick={add} disabled={!newPath.trim()}
          style={{
            fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--accent)',
            border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer', opacity: newPath.trim() ? 1 : 0.4,
          }}>Add</button>
      </div>
    </div>
  );
}

/* ═══ Diff panel ═════════════════════════════════════════════════════ */

function DiffPanel({ entries, onClose }: { entries: DiffEntry[]; onClose: () => void }) {
  if (!entries.length) return null;
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 10, boxShadow: 'var(--shadow-grouped)', padding: '10px 12px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Pending Changes</span>
        <button type="button" onClick={onClose} style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>Done</button>
      </div>
      <div style={{ maxHeight: 140, overflowY: 'auto' }}>
        {entries.map((e, i) => (
          <div key={i} style={{
            fontSize: 12, fontFamily: 'SF Mono, Menlo, monospace', padding: '3px 0',
            display: 'flex', gap: 6, alignItems: 'baseline',
            borderBottom: i < entries.length - 1 ? '1px solid var(--border-row)' : 'none',
          }}>
            <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{e.section}</span>
            <span style={{ color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.field}</span>
            <span style={{ color: 'var(--destructive)', flexShrink: 0 }}>{fmt(e.from)}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>&rarr;</span>
            <span style={{ color: 'var(--success)', flexShrink: 0 }}>{fmt(e.to)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══ AI Activity panel ═════════════════════════════════════════════ */

interface AIEntry {
  id: number;
  type: string;
  provider: string;
  model: string;
  url: string;
  status: 'ok' | 'error' | 'pending';
  duration_ms: number;
  input_size: number;
  output_size: number;
  error?: string;
  timestamp: string;
}

interface AIStats {
  total_requests: number;
  total_errors: number;
  total_duration_ms: number;
  by_type: Record<string, { count: number; errors: number; total_ms: number }>;
}

/* ── Helpers ── */

const TYPE_META: Record<string, { label: string; icon: string; color: string }> = {
  embed:           { label: 'Embed',   icon: 'E', color: '#5856d6' },
  embed_batch:     { label: 'Batch',   icon: 'B', color: '#af52de' },
  generate:        { label: 'LLM',     icon: 'G', color: '#007aff' },
  generate_stream: { label: 'Stream',  icon: 'S', color: '#32ade6' },
  rerank:          { label: 'Rerank',  icon: 'R', color: '#ff9500' },
};
const typeMeta = (t: string) => TYPE_META[t] ?? { label: t, icon: '?', color: 'var(--text-tertiary)' };
const fmtMs = (ms: number) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };
const fmtAgo = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

/* ── Stat card (glass pill) ── */
function StatPill({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      flex: 1, minWidth: 0, padding: '8px 10px',
      background: 'var(--fill-control)', borderRadius: 10,
      backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      border: '0.5px solid var(--border)',
      boxShadow: 'var(--shadow-control)',
    }}>
      <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)', marginBottom: 2 }}>
        {label}
      </div>
      <div className="text-[15px] font-bold tabular-nums" style={{ color: color ?? 'var(--text-primary)', lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div className="text-[10px] tabular-nums" style={{ color: 'var(--text-tertiary)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

/* ── Type breakdown mini-bar ── */
function TypeBar({ stats }: { stats: AIStats }) {
  const types = Object.entries(stats.by_type);
  const total = stats.total_requests || 1;
  return (
    <div style={{ display: 'flex', gap: 1, height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--bg-inset)' }}>
      {types.map(([type, s]) => (
        <div key={type} title={`${typeMeta(type).label}: ${s.count}`} style={{
          width: `${(s.count / total) * 100}%`,
          background: typeMeta(type).color,
          minWidth: 2,
          borderRadius: 1,
          transition: 'width .3s ease',
        }} />
      ))}
    </div>
  );
}

/* ── Single request row ── */
function RequestRow({ entry, isLast }: { entry: AIEntry; isLast: boolean }) {
  const [showDetail, setShowDetail] = useState(false);
  const meta = typeMeta(entry.type);
  const isPending = entry.status === 'pending';

  return (
    <div style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-row)' }}>
      <button type="button" onClick={() => setShowDetail(!showDetail)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 12px', background: 'none', border: 'none', cursor: 'pointer',
        textAlign: 'left', transition: 'background .1s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-active)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
        {/* Status indicator */}
        <span style={{
          width: 7, height: 7, borderRadius: 4, flexShrink: 0,
          background: entry.status === 'ok' ? 'var(--success)' : entry.status === 'error' ? 'var(--destructive)' : 'var(--warning)',
          boxShadow: isPending ? '0 0 6px var(--warning)' : entry.status === 'ok' ? '0 0 4px var(--success)' : undefined,
          animation: isPending ? 'pulse 1.5s ease-in-out infinite' : undefined,
        }} />

        {/* Type badge */}
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.03em',
          padding: '1px 5px', borderRadius: 4,
          background: meta.color + '1a',
          color: meta.color,
          flexShrink: 0,
          fontFamily: 'SF Mono, Menlo, monospace',
        }}>
          {meta.label.toUpperCase()}
        </span>

        {/* Provider + model */}
        <span className="flex-1 min-w-0 truncate" style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>
          {entry.provider}
          <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> {entry.model}</span>
        </span>

        {/* Duration or pending */}
        <span className="tabular-nums" style={{
          fontSize: 11, flexShrink: 0,
          fontFamily: 'SF Mono, Menlo, monospace',
          color: isPending ? 'var(--warning)' : entry.duration_ms > 5000 ? 'var(--destructive)' : entry.duration_ms > 1000 ? 'var(--warning)' : 'var(--text-secondary)',
        }}>
          {isPending ? '...' : fmtMs(entry.duration_ms)}
        </span>

        {/* Time ago */}
        <span className="tabular-nums" style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0, width: 52, textAlign: 'right' }}>
          {fmtAgo(entry.timestamp)}
        </span>
      </button>

      {/* Expanded detail */}
      {showDetail && (
        <div style={{
          padding: '4px 12px 8px 32px', fontSize: 11,
          fontFamily: 'SF Mono, Menlo, monospace',
          display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px',
          color: 'var(--text-secondary)',
        }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Time</span>
          <span>{fmtTime(entry.timestamp)}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>URL</span>
          <span className="truncate">{entry.url}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>Input</span>
          <span>{entry.type.startsWith('embed') ? `${entry.input_size} items` : `${entry.input_size.toLocaleString()} chars`}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>Output</span>
          <span>{entry.type.startsWith('embed') ? `${entry.output_size} vectors` : `${entry.output_size.toLocaleString()} chars`}</span>
          {entry.error && <>
            <span style={{ color: 'var(--destructive)' }}>Error</span>
            <span style={{ color: 'var(--destructive)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{entry.error}</span>
          </>}
        </div>
      )}
    </div>
  );
}

/* ── Main component ── */
function AIActivity() {
  const [entries, setEntries] = useState<AIEntry[]>([]);
  const [stats, setStats] = useState<AIStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch('http://127.0.0.1:3741/api/ai/activity?limit=100');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setEntries(data.entries ?? []);
      setStats(data.stats ?? null);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, 2500);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const hasPending = entries.some(e => e.status === 'pending');
  const filtered = filter ? entries.filter(e => e.type === filter) : entries;
  const errorRate = stats && stats.total_requests > 0 ? Math.round((stats.total_errors / stats.total_requests) * 100) : 0;
  const avgMs = stats && stats.total_requests > 0 ? Math.round(stats.total_duration_ms / stats.total_requests) : 0;

  return (
    <div className="space-y-3" style={{ marginTop: 20 }}>
      {/* ── Section header ── */}
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
          Activity Monitor
        </div>
        {hasPending && (
          <span style={{
            width: 6, height: 6, borderRadius: 3,
            background: 'var(--success)',
            boxShadow: '0 0 6px var(--success)',
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
        )}
        {error && !loading && entries.length === 0 && (
          <span className="text-[10px]" style={{ color: 'var(--destructive)' }}>Offline</span>
        )}
      </div>

      {/* ── Stats pills ── */}
      {stats && stats.total_requests > 0 && (
        <>
          <div className="flex gap-2">
            <StatPill label="Requests" value={stats.total_requests.toLocaleString()} sub={`${Object.keys(stats.by_type).length} type${Object.keys(stats.by_type).length !== 1 ? 's' : ''}`} />
            <StatPill label="Avg latency" value={fmtMs(avgMs)} sub={`total ${fmtMs(stats.total_duration_ms)}`} color={avgMs > 3000 ? 'var(--destructive)' : avgMs > 1000 ? 'var(--warning)' : undefined} />
            <StatPill label="Errors" value={stats.total_errors.toString()} sub={errorRate > 0 ? `${errorRate}% rate` : 'none'} color={stats.total_errors > 0 ? 'var(--destructive)' : 'var(--success)'} />
          </div>
          <TypeBar stats={stats} />
        </>
      )}

      {/* ── Filter chips ── */}
      {stats && Object.keys(stats.by_type).length > 1 && (
        <div className="flex gap-1.5 flex-wrap">
          <button type="button" onClick={() => setFilter(null)}
            className="text-[10px] font-medium px-2.5 py-1 rounded-full transition-all"
            style={{
              background: !filter ? 'var(--accent)' : 'var(--fill-control)',
              color: !filter ? '#fff' : 'var(--text-secondary)',
              border: '0.5px solid ' + (!filter ? 'var(--accent)' : 'var(--border)'),
              cursor: 'pointer',
            }}>
            All
          </button>
          {Object.entries(stats.by_type).map(([type, s]) => {
            const meta = typeMeta(type);
            const active = filter === type;
            return (
              <button key={type} type="button" onClick={() => setFilter(active ? null : type)}
                className="text-[10px] font-medium px-2.5 py-1 rounded-full transition-all flex items-center gap-1"
                style={{
                  background: active ? meta.color + '22' : 'var(--fill-control)',
                  color: active ? meta.color : 'var(--text-secondary)',
                  border: '0.5px solid ' + (active ? meta.color + '44' : 'var(--border)'),
                  cursor: 'pointer',
                  backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                }}>
                {meta.label}
                <span className="tabular-nums" style={{ opacity: 0.7 }}>{s.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Request list ── */}
      <div style={{
        background: 'var(--bg-grouped)', borderRadius: 10,
        boxShadow: 'var(--shadow-grouped)', overflow: 'hidden',
      }}>
        <div style={{
          maxHeight: 320, overflowY: 'auto',
          scrollbarWidth: 'thin', scrollbarColor: 'var(--text-tertiary) transparent',
        }}>
          {loading && entries.length === 0 && (
            <div className="text-center py-6 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Connecting to daemon...
            </div>
          )}
          {!loading && entries.length === 0 && !error && (
            <div className="text-center py-8 px-4">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                No AI requests yet
              </div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Requests appear here during indexing and semantic search
              </div>
            </div>
          )}
          {error && entries.length === 0 && (
            <div className="text-center py-6 px-4">
              <div className="text-[11px] font-medium" style={{ color: 'var(--destructive)' }}>
                Cannot reach daemon
              </div>
              <div className="text-[10px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{error}</div>
            </div>
          )}
          {filtered.map((e, i) => (
            <RequestRow key={e.id} entry={e} isLast={i === filtered.length - 1} />
          ))}
          {filter && filtered.length === 0 && entries.length > 0 && (
            <div className="text-center py-4 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              No {typeMeta(filter).label.toLowerCase()} requests
            </div>
          )}
        </div>
      </div>

      {/* Pulse animation */}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}

/* ═══ Bottom bar ═════════════════════════════════════════════════════ */

function BottomBar({ dirty, saving, hasErrors, diffCount, showDiff, onToggleDiff, onSave, onDiscard, saveStatus }: {
  dirty: boolean; saving: boolean; hasErrors: boolean; diffCount: number;
  showDiff: boolean; onToggleDiff: () => void; onSave: () => void; onDiscard: () => void;
  saveStatus: 'idle' | 'saved' | 'error';
}) {
  if (!dirty) return null;
  const msg = hasErrors ? 'Fix issues before saving'
    : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Save failed'
    : `${diffCount} unsaved change${diffCount !== 1 ? 's' : ''}`;
  const btn: React.CSSProperties = {
    fontSize: 13, fontWeight: 500, border: 'none', borderRadius: 6,
    padding: '5px 14px', cursor: 'pointer', transition: 'background .15s',
  };
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
      background: 'var(--bg-primary)', borderTop: '1px solid var(--border)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    }}>
      <span style={{ fontSize: 12, flex: 1, color: hasErrors ? 'var(--destructive)' : saveStatus === 'saved' ? 'var(--success)' : 'var(--text-secondary)' }}>{msg}</span>
      {diffCount > 0 && !hasErrors && (
        <button type="button" onClick={onToggleDiff} style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>
          {showDiff ? 'Hide' : 'Review'}
        </button>
      )}
      <button type="button" onClick={onDiscard} style={{ ...btn, color: 'var(--text-primary)', background: 'var(--bg-inset)' }}>Discard</button>
      <button type="button" onClick={onSave} disabled={saving || hasErrors}
        style={{ ...btn, color: '#fff', background: hasErrors ? 'var(--text-tertiary)' : 'var(--accent)', opacity: saving ? 0.6 : 1 }}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

/* ═══ Main ═══════════════════════════════════════════════════════════ */

type Screen = { type: 'list' } | { type: 'section'; key: string } | { type: 'picker'; sectionKey: string; picker: PickerInfo } | { type: 'projects' };

export function Settings() {
  const { settings, loading, connected, restarting, restartDaemon, updateSettings } = useDaemon();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [local, setLocal] = useState<Record<string, unknown> | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [search, setSearch] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [screen, setScreen] = useState<Screen>(() => {
    const section = new URLSearchParams(window.location.search).get('section');
    if (section && CONFIG_SCHEMA.some(s => s.key === section)) {
      return { type: 'section', key: section };
    }
    return { type: 'list' };
  });

  const server = (settings?.settings as Record<string, unknown>) ?? {};
  const config = local ?? server;

  const update = useCallback((key: string, data: Record<string, unknown>) => {
    setLocal(prev => {
      const base = prev ?? (settings?.settings as Record<string, unknown>) ?? {};
      if (key === '_root') { const u = { ...base }; for (const [k, v] of Object.entries(data)) { if (v !== undefined) u[k] = v; else delete u[k]; } return u; }
      return { ...base, [key]: data };
    });
    setDirty(true); setSaveStatus('idle');
  }, [settings]);

  const updateFull = useCallback((c: Record<string, unknown>) => { setLocal(c); setDirty(true); setSaveStatus('idle'); }, []);

  const save = useCallback(async () => {
    if (!local) return; setSaving(true);
    try { await updateSettings(local); setDirty(false); setSaveStatus('saved'); setShowDiff(false); setTimeout(() => setSaveStatus('idle'), 2000); }
    catch { setSaveStatus('error'); } finally { setSaving(false); }
  }, [local, updateSettings]);

  const discard = useCallback(() => { setLocal(null); setDirty(false); setSaveStatus('idle'); setShowDiff(false); }, []);

  const hasErrors = useMemo(() => CONFIG_SCHEMA.some(s => Object.keys(validateSection(s, sd(config, s))).length > 0), [config]);
  const diffs = useMemo(() => dirty ? computeDiff(server, config) : [], [dirty, server, config]);

  const q = search.toLowerCase().trim();
  const matchSection = (s: SectionDef) => {
    if (!q) return true;
    if (s.label.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)) return true;
    return s.fields.some(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q) || f.description?.toLowerCase().includes(q));
  };

  /* Not connected */
  if (!connected && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Daemon not reachable
        </div>
        <button
          onClick={() => restartDaemon()}
          disabled={restarting}
          className="text-[11px] px-4 py-1.5 rounded-lg font-medium transition-all"
          style={{
            background: 'var(--fill-control)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            color: 'var(--accent)',
            border: '0.5px solid var(--border)',
            boxShadow: 'var(--shadow-control)',
            cursor: restarting ? 'default' : 'pointer',
            opacity: restarting ? 0.6 : 1,
          }}
        >
          {restarting ? 'Starting…' : 'Restart Daemon'}
        </button>
      </div>
    );
  }

  if (loading || !settings) {
    return <p style={{ fontSize: 13, textAlign: 'center', padding: 32, color: 'var(--text-tertiary)', margin: 0 }}>Loading…</p>;
  }

  const { daemon } = settings;
  const filtered = CONFIG_SCHEMA.filter(matchSection);

  const bottomBar = (
    <BottomBar dirty={dirty} saving={saving} hasErrors={hasErrors} diffCount={diffs.length}
      showDiff={showDiff} onToggleDiff={() => setShowDiff(!showDiff)}
      onSave={save} onDiscard={discard} saveStatus={saveStatus} />
  );

  /* ── Picker screen ── */
  if (screen.type === 'picker') {
    const sec = CONFIG_SCHEMA.find(s => s.key === screen.sectionKey);
    return (
      <div style={{ paddingBottom: 52 }}>
        <PickerScreen picker={screen.picker} sectionLabel={sec?.label ?? 'Back'}
          onBack={() => setScreen({ type: 'section', key: screen.sectionKey })} />
        {bottomBar}
      </div>
    );
  }

  /* ── Projects screen ── */
  if (screen.type === 'projects') {
    return (
      <div style={{ paddingBottom: 52 }}>
        <ProjectsScreen config={config} onUpdate={updateFull} onBack={() => setScreen({ type: 'list' })} />
        {bottomBar}
      </div>
    );
  }

  /* ── Section detail screen ── */
  if (screen.type === 'section') {
    const sec = CONFIG_SCHEMA.find(s => s.key === screen.key);
    if (!sec) { setScreen({ type: 'list' }); return null; }
    return (
      <div style={{ paddingBottom: 52 }}>
        <SectionDetail
          section={sec} data={sd(config, sec)}
          onUpdate={update}
          onBack={() => setScreen({ type: 'list' })}
          onOpenPicker={(p) => setScreen({ type: 'picker', sectionKey: screen.key, picker: p })}
        />
        {showDiff && <DiffPanel entries={diffs} onClose={() => setShowDiff(false)} />}
        {bottomBar}
      </div>
    );
  }

  /* ── Main list screen ── */
  return (
    <div style={{ paddingBottom: 52 }}>
      {/* Daemon card */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        background: 'var(--bg-grouped)', borderRadius: 10,
        boxShadow: 'var(--shadow-grouped)', marginBottom: 16,
      }}>
        <StatusDot status="active" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Daemon</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
            PID {daemon.pid} &middot; Port {daemon.port} &middot; {formatUptime(daemon.uptime)}
          </div>
        </div>
        <button type="button"
          onClick={() => { const api = (window as any).electronAPI; if (api?.openInEditor) api.openInEditor(settings.path); }}
          style={{
            fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--accent)',
            border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
          }}>Edit JSON</button>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M16 16L20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search"
          style={{
            fontSize: 13, fontFamily: 'inherit', width: '100%', height: 28,
            padding: '0 28px 0 30px', borderRadius: 7,
            border: '1px solid var(--border)', background: 'var(--fill-control)',
            color: 'var(--text-primary)', boxShadow: 'var(--shadow-control)',
          }} />
        {search && (
          <button type="button" onClick={() => setSearch('')}
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              width: 18, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
              background: 'var(--bg-inset)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, lineHeight: 1, color: 'var(--text-tertiary)',
            }}>×</button>
        )}
      </div>

      {/* Section list */}
      <SectionList sections={filtered} config={config} onOpen={(key) => setScreen({ type: 'section', key })} search={search} />

      {/* Per-project row */}
      {(!q || 'project override'.includes(q)) && (
        <div style={{
          background: 'var(--bg-grouped)', borderRadius: 10,
          boxShadow: 'var(--shadow-grouped)', overflow: 'hidden',
        }}>
          <button type="button" onClick={() => setScreen({ type: 'projects' })}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
            }}>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>Per-project Overrides</span>
            {Object.keys((config.projects ?? {}) as object).length > 0 && (
              <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--accent)', flexShrink: 0 }} />
            )}
            <ChevronRight />
          </button>
        </div>
      )}

      {showDiff && <div style={{ marginTop: 16 }}><DiffPanel entries={diffs} onClose={() => setShowDiff(false)} /></div>}
      {bottomBar}
    </div>
  );
}
