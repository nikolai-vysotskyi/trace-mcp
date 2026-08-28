/**
 * Activity tab — container with two sub-tabs:
 *   - "Tool calls": MCP tool-call feed for the current project (ToolActivity)
 *   - "AI calls":   embed / LLM / rerank requests (AIActivity, project-agnostic)
 *
 * Active sub-tab persists in localStorage under key 'activity.subtab'.
 *
 * This container owns the sub-tab STATE but not a row of its own: it hands the
 * switcher down and each surface renders it on the leading edge of its single
 * toolbar. Before TRA-294 the switcher sat in a bar of its own above whatever
 * the child stacked underneath, which is how the screen ended up with three
 * control rows and no toolbar.
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

  const switcher = (
    <SegmentedControl
      className="shrink-0"
      options={[
        { value: 'tool', label: 'Tool calls' },
        { value: 'ai', label: 'AI calls' },
      ]}
      value={sub}
      onChange={setSub}
      aria-label="Activity source"
    />
  );

  return sub === 'tool' ? (
    <ToolActivity root={root} subTab={switcher} onOpenFileInGraph={onOpenFileInGraph} />
  ) : (
    <AIActivity subTab={switcher} />
  );
}
