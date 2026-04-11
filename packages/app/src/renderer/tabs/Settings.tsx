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

function FieldControl({ field, value, onChange, onOpenPicker }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; onOpenPicker?: () => void;
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
          const isBlock = field.type === 'json' || field.type === 'array';
          const changeFn = (v: unknown) => onUpdate(section.key, sv(data, field, v));

          return (
            <div key={`${field.nested ?? ''}.${field.key}`}
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
                  {field.description && !isBlock && (
                    <span title={field.description}
                      style={{
                        fontSize: 10, color: 'var(--text-tertiary)', width: 14, height: 14, borderRadius: 7,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--bg-inset)', cursor: 'help', flexShrink: 0, fontWeight: 600,
                      }}>?</span>
                  )}
                  {(isModified || (!hasDef && isSet)) && (
                    <button type="button" onClick={() => changeFn(field.defaultValue)}
                      style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, opacity: 0.7, flexShrink: 0 }}
                      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>
                      Reset
                    </button>
                  )}
                </div>
                {!isBlock && (
                  <FieldControl field={field} value={value} onChange={changeFn}
                    onOpenPicker={field.type === 'select' ? () => onOpenPicker({ field, value, onChange: changeFn }) : undefined} />
                )}
              </div>
              {isBlock && <div style={{ paddingBottom: 8 }}><FieldControl field={field} value={value} onChange={changeFn} /></div>}
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
  const [screen, setScreen] = useState<Screen>({ type: 'list' });

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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', margin: 0 }}>Daemon not reachable</p>
        <button type="button" onClick={() => restartDaemon()} disabled={restarting}
          style={{
            fontSize: 13, fontWeight: 500,
            color: 'var(--accent)',
            background: 'var(--fill-control)',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            border: '0.5px solid var(--border)',
            borderRadius: 8, padding: '6px 18px',
            boxShadow: 'var(--shadow-control)',
            cursor: restarting ? 'default' : 'pointer',
            opacity: restarting ? 0.6 : 1,
          }}>
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
