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
import { SegmentedControl } from '../lattice/ui';

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

export function Activity({
  root,
  onOpenFileInGraph,
}: {
  root: string;
  onOpenFileInGraph?: (filePath: string) => void;
}) {
  const [sub, setSub] = useState<SubTab>(readStored);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, sub); } catch { /* ignore quota */ }
  }, [sub]);

  return (
    <div className="flex flex-col h-full" style={{ color: 'var(--text-primary)' }}>
      <div
        className="shrink-0 flex items-center px-3 pt-3 pb-2"
        style={{ borderBottom: '0.5px solid var(--border-row)' }}
      >
        <SegmentedControl
          options={[
            { value: 'tool', label: 'Tool calls' },
            { value: 'ai', label: 'AI calls' },
          ]}
          value={sub}
          onChange={setSub}
          aria-label="Activity source"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {sub === 'tool' ? (
          <ToolActivity root={root} onOpenFileInGraph={onOpenFileInGraph} />
        ) : (
          <AIActivity />
        )}
      </div>
    </div>
  );
}
