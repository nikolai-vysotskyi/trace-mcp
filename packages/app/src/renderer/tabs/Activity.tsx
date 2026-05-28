/**
 * Activity tab — container with two sub-tabs:
 *   - "Tool calls": MCP tool-call feed for the current project (ToolActivity)
 *   - "AI calls":   embed / LLM / rerank requests (AIActivity, project-agnostic)
 *
 * Active sub-tab persists in localStorage under key 'activity.subtab'.
 */
import { useEffect, useState } from 'react';
import { ToolActivity } from './ToolActivity';
import { AIActivity } from './AIActivity';

type SubTab = 'tool' | 'ai';
const STORAGE_KEY = 'activity.subtab';

function readStored(): SubTab {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'ai' ? 'ai' : 'tool';
  } catch {
    return 'tool';
  }
}

export function Activity({ root }: { root: string }) {
  const [sub, setSub] = useState<SubTab>(readStored);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, sub); } catch { /* ignore quota */ }
  }, [sub]);

  return (
    <div className="flex flex-col h-full" style={{ color: 'var(--text-primary)' }}>
      {/* Sub-tab segmented control */}
      <div
        className="shrink-0 flex items-center gap-1 px-3 pt-3 pb-2"
        style={{ borderBottom: '0.5px solid var(--border-row)' }}
      >
        <SubTabButton label="Tool calls" active={sub === 'tool'} onClick={() => setSub('tool')} />
        <SubTabButton label="AI calls"   active={sub === 'ai'}   onClick={() => setSub('ai')} />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {sub === 'tool' ? <ToolActivity root={root} /> : <AIActivity />}
      </div>
    </div>
  );
}

function SubTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] px-2.5 py-1 rounded-full transition-all"
      style={{
        background: active ? 'var(--accent)' : 'var(--bg-inset)',
        color: active ? '#fff' : 'var(--text-secondary)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        border: 'none',
      }}
    >
      {label}
    </button>
  );
}
