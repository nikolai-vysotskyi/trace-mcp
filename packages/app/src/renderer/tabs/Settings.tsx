import { useState, useCallback, useMemo } from 'react';
import { StatusDot } from '../components/StatusDot';
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

/* ═══ Helpers ═══════════════════════════════════════════════════════════ */

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

/* ═══ macOS Toggle (38×22, matches NSSwitch) ═══════════════════════════ */

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button" role="switch" aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        position: 'relative', width: 38, height: 22, borderRadius: 11, padding: 0,
        background: on ? 'var(--accent)' : 'var(--fill-toggle-off)',
        border: 'none', cursor: 'pointer', transition: 'background .2s ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, width: 18, height: 18, borderRadius: 9,
        left: on ? 18 : 2, background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.2), 0 0 0 .5px rgba(0,0,0,.04)',
        transition: 'left .2s cubic-bezier(.4,0,.2,1)',
      }} />
    </button>
  );
}

/* ═══ Chevron ══════════════════════════════════════════════════════════ */

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="6" height="10" viewBox="0 0 6 10" fill="none"
      style={{ transition: 'transform .15s ease', transform: open ? 'rotate(90deg)' : 'rotate(0)', flexShrink: 0 }}>
      <path d="M1 1L5 5L1 9" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ═══ Controls ════════════════════════════════════════════════════════ */

function Control({ field, value, onChange }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void;
}) {
  const err = validateField(field, value);
  const errStyle = err ? { borderColor: 'var(--destructive)' } : {};

  const inputBase: React.CSSProperties = {
    fontSize: 13, fontFamily: 'inherit', height: 22,
    padding: '0 6px', borderRadius: 5,
    border: '1px solid var(--border)', background: 'var(--fill-control)',
    color: 'var(--text-primary)', boxShadow: 'var(--shadow-control)',
    ...errStyle,
  };

  const hint = err ? <div style={{ fontSize: 11, color: 'var(--destructive)', marginTop: 2 }}>{err}</div> : null;

  switch (field.type) {
    case 'boolean':
      return <Toggle on={!!value} onChange={(v) => onChange(v)} />;

    case 'select':
      return (
        <div>
          <select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}
            style={{ ...inputBase, minWidth: 100, cursor: 'pointer' }}>
            <option value="">—</option>
            {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {hint}
        </div>
      );

    case 'number':
      return (
        <div>
          <input type="number" value={value != null ? String(value) : ''} placeholder={field.placeholder}
            min={field.min} max={field.max}
            onChange={(e) => { const v = e.target.value; onChange(v === '' ? undefined : Number(v)); }}
            style={{ ...inputBase, width: 80, textAlign: 'right' }} />
          {hint}
        </div>
      );

    case 'string':
      return (
        <div style={{ flex: 1, minWidth: 0, maxWidth: 180 }}>
          <input type={field.sensitive ? 'password' : 'text'} value={(value as string) ?? ''}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value || undefined)}
            style={{ ...inputBase, width: '100%', textAlign: 'right' }} />
          {hint}
        </div>
      );

    case 'array':
      return <ArrayCtrl value={value as string[] | undefined} placeholder={field.placeholder} onChange={onChange} base={inputBase} />;
    case 'json':
      return <JsonCtrl value={value} placeholder={field.description} onChange={onChange} />;
    default: return null;
  }
}

function ArrayCtrl({ value, placeholder, onChange, base }: {
  value: string[] | undefined; placeholder?: string; onChange: (v: unknown) => void; base: React.CSSProperties;
}) {
  const [text, setText] = useState(() => (value ?? []).join(', '));
  return (
    <input type="text" value={text} placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { const items = text.split(',').map(s => s.trim()).filter(Boolean); onChange(items.length ? items : undefined); }}
      style={{ ...base, width: '100%', textAlign: 'left', height: 24 }} />
  );
}

function JsonCtrl({ value, placeholder, onChange }: {
  value: unknown; placeholder?: string; onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => value != null ? JSON.stringify(value, null, 2) : '');
  const [error, setError] = useState(false);
  return (
    <div style={{ width: '100%' }}>
      <textarea value={text} placeholder={placeholder} rows={3}
        onChange={(e) => { setText(e.target.value); setError(false); }}
        onBlur={() => { if (!text.trim()) { setError(false); onChange(undefined); return; }
          try { onChange(JSON.parse(text)); setError(false); } catch { setError(true); } }}
        style={{
          fontSize: 12, fontFamily: 'SF Mono, Menlo, monospace', width: '100%',
          padding: 6, borderRadius: 5, resize: 'vertical',
          border: `1px solid ${error ? 'var(--destructive)' : 'var(--border)'}`,
          background: 'var(--fill-control)', color: 'var(--text-primary)',
          boxShadow: 'var(--shadow-control)',
        }} />
      {error && <div style={{ fontSize: 11, color: 'var(--destructive)', marginTop: 2 }}>Invalid JSON</div>}
    </div>
  );
}

/* ═══ Setting Row (macOS System Settings style) ═══════════════════════ */

function SettingRow({ field, value, onChange, onReset, isLast }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void;
  onReset?: () => void; isLast: boolean;
}) {
  const isBlock = field.type === 'json' || field.type === 'array';

  return (
    <div style={{ padding: '0 12px', borderBottom: isLast ? 'none' : '1px solid var(--border-row)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, minHeight: 34, padding: isBlock ? '8px 0 4px' : '0',
      }}>
        {/* Label side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
            {field.nested && <span style={{ color: 'var(--text-tertiary)' }}>{field.nested}.</span>}
            {field.label}
          </span>
          {field.description && !isBlock && (
            <span title={field.description}
              style={{
                fontSize: 11, color: 'var(--text-tertiary)', width: 14, height: 14, borderRadius: 7,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--bg-inset)', cursor: 'help', flexShrink: 0, fontWeight: 500,
              }}>?</span>
          )}
          {onReset && (
            <button type="button" onClick={onReset}
              style={{
                fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none',
                cursor: 'pointer', padding: 0, opacity: 0.7, flexShrink: 0,
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>
              Reset
            </button>
          )}
        </div>
        {/* Control side */}
        {!isBlock && <Control field={field} value={value} onChange={onChange} />}
      </div>
      {isBlock && (
        <div style={{ paddingBottom: 8 }}>
          <Control field={field} value={value} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/* ═══ Section (grouped box, macOS System Settings style) ══════════════ */

function GroupedSection({ section, data, onUpdate, saving, highlight, forceOpen }: {
  section: SectionDef; data: Record<string, unknown>;
  onUpdate: (k: string, d: Record<string, unknown>) => void;
  saving: boolean; highlight?: string; forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = forceOpen || open;
  const modified = countModifiedFields(section, data);
  const errors = Object.keys(validateSection(section, data)).length;

  const visible = section.fields.filter(f => isFieldVisible(f, data));
  const matched = highlight
    ? visible.filter(f => f.label.toLowerCase().includes(highlight) || f.key.toLowerCase().includes(highlight) ||
        f.description?.toLowerCase().includes(highlight) || f.nested?.toLowerCase().includes(highlight))
    : visible;

  if (highlight && !matched.length) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Section header — looks like macOS settings category */}
      <button
        type="button" disabled={saving}
        onClick={() => setOpen(!isOpen)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          padding: '0 4px 6px', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <Chevron open={isOpen} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
          {section.label}
        </span>
        {!isOpen && errors > 0 && (
          <span style={{ fontSize: 11, color: 'var(--destructive)' }}>
            {errors} {errors === 1 ? 'issue' : 'issues'}
          </span>
        )}
        {!isOpen && modified > 0 && !errors && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            Modified
          </span>
        )}
      </button>

      {/* Grouped box */}
      {isOpen && (
        <div style={{
          background: 'var(--bg-grouped)', borderRadius: 10,
          boxShadow: 'var(--shadow-grouped)', overflow: 'hidden',
        }}>
          {/* Description + reset row */}
          {(section.description || modified > 0) && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderBottom: '1px solid var(--border-row)',
            }}>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flex: 1 }}>
                {section.description}
              </span>
              {modified > 0 && (
                <button type="button"
                  onClick={() => onUpdate(section.key, getSectionDefaults(section))}
                  style={{
                    fontSize: 12, color: 'var(--accent)', background: 'none',
                    border: 'none', cursor: 'pointer', padding: 0, marginLeft: 8, flexShrink: 0,
                  }}>
                  Reset All
                </button>
              )}
            </div>
          )}

          {/* Rows */}
          {matched.map((field, i) => {
            const value = gv(data, field);
            const hasDef = field.defaultValue !== undefined;
            const isModified = hasDef && JSON.stringify(value) !== JSON.stringify(field.defaultValue);
            const isSet = value !== undefined && value !== null && value !== '';
            return (
              <SettingRow
                key={`${field.nested ?? ''}.${field.key}`}
                field={field} value={value}
                onChange={v => onUpdate(section.key, sv(data, field, v))}
                onReset={(isModified || (!hasDef && isSet))
                  ? () => onUpdate(section.key, sv(data, field, field.defaultValue))
                  : undefined}
                isLast={i === matched.length - 1}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══ Diff panel ══════════════════════════════════════════════════════ */

function DiffPanel({ entries, onClose }: { entries: DiffEntry[]; onClose: () => void }) {
  if (!entries.length) return null;
  return (
    <div style={{
      background: 'var(--bg-grouped)', borderRadius: 10,
      boxShadow: 'var(--shadow-grouped)', padding: '10px 12px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Pending Changes</span>
        <button type="button" onClick={onClose}
          style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>
          Done
        </button>
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

/* ═══ Per-project overrides ═══════════════════════════════════════════ */

function ProjectOverrides({ config, onUpdate }: {
  config: Record<string, unknown>; onUpdate: (c: Record<string, unknown>) => void;
}) {
  const projects = (config.projects ?? {}) as Record<string, unknown>;
  const [open, setOpen] = useState(false);
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

  const inputBase: React.CSSProperties = {
    fontSize: 13, fontFamily: 'inherit', height: 24, padding: '0 6px', borderRadius: 5,
    border: '1px solid var(--border)', background: 'var(--fill-control)',
    color: 'var(--text-primary)', boxShadow: 'var(--shadow-control)', width: '100%',
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '0 4px 6px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <Chevron open={open} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>Per-project Overrides</span>
        {!open && paths.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{paths.length}</span>
        )}
      </button>
      {open && (
        <div style={{ background: 'var(--bg-grouped)', borderRadius: 10, boxShadow: 'var(--shadow-grouped)', overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: paths.length ? '1px solid var(--border-row)' : 'none' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Override global settings for specific projects.
            </span>
          </div>
          {paths.map((p, i) => (
            <div key={p} style={{ padding: '8px 12px', borderBottom: i < paths.length - 1 ? '1px solid var(--border-row)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontFamily: 'SF Mono, Menlo, monospace', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{p}</span>
                <button type="button" onClick={() => { if (editKey === p) setEditKey(null); else { setEditKey(p); setEditJson(JSON.stringify(projects[p], null, 2)); setEditError(false); } }}
                  style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {editKey === p ? 'Done' : 'Edit'}
                </button>
                <button type="button" onClick={() => { const u = { ...projects }; delete u[p]; onUpdate({ ...config, projects: u }); if (editKey === p) setEditKey(null); }}
                  style={{ fontSize: 12, color: 'var(--destructive)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  Remove
                </button>
              </div>
              {editKey === p && (
                <div style={{ marginTop: 6 }}>
                  <textarea value={editJson} rows={4}
                    onChange={e => { setEditJson(e.target.value); setEditError(false); }}
                    style={{
                      fontSize: 12, fontFamily: 'SF Mono, Menlo, monospace', width: '100%',
                      padding: 6, borderRadius: 5, resize: 'vertical',
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
          {/* Add */}
          <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderTop: paths.length ? '1px solid var(--border-row)' : 'none' }}>
            <input type="text" value={newPath} placeholder="/path/to/project"
              onChange={e => setNewPath(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
              style={{ ...inputBase, flex: 1 }} />
            <button type="button" onClick={add} disabled={!newPath.trim()}
              style={{
                fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--accent)',
                border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
                opacity: newPath.trim() ? 1 : 0.4,
              }}>Add</button>
          </div>
        </div>
      )}
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

  const btnBase: React.CSSProperties = {
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
      <span style={{
        fontSize: 12, flex: 1,
        color: hasErrors ? 'var(--destructive)' : saveStatus === 'saved' ? 'var(--success)' : 'var(--text-secondary)',
      }}>{msg}</span>

      {diffCount > 0 && !hasErrors && (
        <button type="button" onClick={onToggleDiff}
          style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>
          {showDiff ? 'Hide' : 'Review'}
        </button>
      )}
      <button type="button" onClick={onDiscard}
        style={{ ...btnBase, color: 'var(--text-primary)', background: 'var(--bg-inset)' }}>
        Discard
      </button>
      <button type="button" onClick={onSave} disabled={saving || hasErrors}
        style={{ ...btnBase, color: '#fff', background: hasErrors ? 'var(--text-tertiary)' : 'var(--accent)', opacity: saving ? 0.6 : 1 }}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

/* ═══ Main ═══════════════════════════════════════════════════════════ */

export function Settings() {
  const { settings, loading, connected, restartDaemon, updateSettings } = useDaemon();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [local, setLocal] = useState<Record<string, unknown> | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [search, setSearch] = useState('');
  const [showDiff, setShowDiff] = useState(false);

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
  const match = (s: SectionDef) => {
    if (!q) return true;
    if (s.label.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)) return true;
    return s.fields.some(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q) || f.description?.toLowerCase().includes(q) || f.nested?.toLowerCase().includes(q));
  };

  /* Not connected */
  if (!connected && !loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', margin: 0 }}>Daemon not reachable</p>
        <button type="button" onClick={() => restartDaemon()}
          style={{ fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--accent)', border: 'none', borderRadius: 6, padding: '6px 16px', cursor: 'pointer' }}>
          Start Daemon
        </button>
      </div>
    );
  }

  if (loading || !settings) {
    return <p style={{ fontSize: 13, textAlign: 'center', padding: 32, color: 'var(--text-tertiary)', margin: 0 }}>Loading…</p>;
  }

  const { daemon } = settings;
  const filtered = CONFIG_SCHEMA.filter(match);

  const searchInputStyle: React.CSSProperties = {
    fontSize: 13, fontFamily: 'inherit', width: '100%', height: 28,
    padding: '0 28px 0 30px', borderRadius: 7,
    border: '1px solid var(--border)', background: 'var(--fill-control)',
    color: 'var(--text-primary)', boxShadow: 'var(--shadow-control)',
  };

  return (
    <div style={{ paddingBottom: 52 }}>
      {/* ── Daemon status ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        background: 'var(--bg-grouped)', borderRadius: 10,
        boxShadow: 'var(--shadow-grouped)', marginBottom: 16,
      }}>
        <StatusDot status="active" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Daemon</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
            PID {daemon.pid} &middot; Port {daemon.port} &middot; Uptime {formatUptime(daemon.uptime)}
          </div>
        </div>
        <button type="button"
          onClick={() => { const api = (window as any).electronAPI; if (api?.openInEditor) api.openInEditor(settings.path); }}
          style={{
            fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--accent)',
            border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
          }}>
          Edit JSON
        </button>
      </div>

      {/* ── Search ── */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M16 16L20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search" style={searchInputStyle} />
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

      {/* ── Sections ── */}
      {filtered.map(section => (
        <GroupedSection key={section.key} section={section} data={sd(config, section)}
          onUpdate={update} saving={saving} highlight={q || undefined} forceOpen={!!q} />
      ))}

      {(!q || 'project override'.includes(q)) && (
        <ProjectOverrides config={config} onUpdate={updateFull} />
      )}

      {q && !filtered.length && (
        <p style={{ fontSize: 13, textAlign: 'center', padding: 24, color: 'var(--text-tertiary)', margin: 0 }}>
          No settings match &ldquo;{search}&rdquo;
        </p>
      )}

      {showDiff && <DiffPanel entries={diffs} onClose={() => setShowDiff(false)} />}

      <BottomBar dirty={dirty} saving={saving} hasErrors={hasErrors} diffCount={diffs.length}
        showDiff={showDiff} onToggleDiff={() => setShowDiff(!showDiff)}
        onSave={save} onDiscard={discard} saveStatus={saveStatus} />
    </div>
  );
}
