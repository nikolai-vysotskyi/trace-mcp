import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../i18n/format';
import { Button } from '../lattice/ui';
import { isExternalNode, type Connections, type Direction } from './graph-exploration';

export interface ExploreNode {
  id: string;
  label: string;
}

export function GraphConnections({
  selected,
  nodes,
  index,
  direction,
  onDirection,
  depth,
  onDepth,
  onSelect,
  onBack,
  onClear,
}: {
  selected: ExploreNode;
  nodes: Map<string, ExploreNode>;
  index: Connections;
  direction: Direction;
  onDirection: (direction: Direction) => void;
  depth: number;
  onDepth: (depth: number) => void;
  onSelect: (id: string) => void;
  onBack?: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('graph');
  const [query, setQuery] = useState('');
  const incoming = index.incoming.get(selected.id) ?? new Map<string, Set<string>>();
  const outgoing = index.outgoing.get(selected.id) ?? new Map<string, Set<string>>();
  const shownIncoming = direction === 'outgoing' ? new Map<string, Set<string>>() : incoming;
  const shownOutgoing = direction === 'incoming' ? new Map<string, Set<string>>() : outgoing;
  const ids = new Set([
    ...shownIncoming.keys(),
    ...shownOutgoing.keys(),
  ]);
  const rows = [...ids]
    .filter((id) => `${id}\n${nodes.get(id)?.label}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (index.degree.get(b) ?? 0) - (index.degree.get(a) ?? 0) || a.localeCompare(b));
  return (
    <section className="graph-connections" aria-label={t('connections')}>
      <div className="graph-explore-actions">
        {onBack && (
          <Button size="small" onClick={onBack}>
            {t('back')}
          </Button>
        )}
        <Button size="small" onClick={onClear}>
          {t('allNodes')}
        </Button>
        <span className="graph-secondary">
          {t('uniqueNeighbors', { total: formatNumber(index.degree.get(selected.id) ?? 0) })}
        </span>
      </div>
      <div className="graph-directions" role="group" aria-label={t('connectionDirection')}>
        {(['both', 'incoming', 'outgoing'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={direction === value}
            onClick={() => onDirection(value)}
          >
            {t(value)}
            {value !== 'both' && (
              <span>{formatNumber(value === 'incoming' ? incoming.size : outgoing.size)}</span>
            )}
          </button>
        ))}
      </div>
      <div className="graph-explore-actions">
        <span className="graph-secondary">{t('neighborhood')}</span>
        {[1, 2].map((value) => (
          <button
            type="button"
            className="cosmos-gpu-pill-btn"
            key={value}
            aria-pressed={depth === value}
            onClick={() => onDepth(value)}
          >
            {t('hops', { total: value })}
          </button>
        ))}
      </div>
      <input
        className="graph-connection-search"
        aria-label={t('filterConnections')}
        placeholder={t('filterConnections')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="graph-connection-list">
        {rows.slice(0, 60).map((id) => (
          <button
            type="button"
            className="graph-connection-row"
            key={id}
            title={id}
            onClick={() => {
              setQuery('');
              onSelect(id);
            }}
          >
            <span className="graph-connection-name">
              {shownIncoming.has(id) && shownOutgoing.has(id) ? '↔' : shownOutgoing.has(id) ? '→' : '←'}{' '}
              {nodes.get(id)?.label ?? id}
              {isExternalNode(id) ? ` · ${t('external')}` : ''}
            </span>
            <span className="graph-secondary graph-connection-path">{id}</span>
            <span className="graph-secondary">
              {[...new Set([...(shownIncoming.get(id) ?? []), ...(shownOutgoing.get(id) ?? [])])].join(' · ')}
            </span>
          </button>
        ))}
        {rows.length === 0 && <p className="graph-secondary">{t('noConnections')}</p>}
      </div>
      <p className="graph-secondary graph-explore-note">
        {t('connectionScope', { shown: Math.min(60, rows.length), total: rows.length })}
      </p>
    </section>
  );
}

export function GraphHubs({
  nodes,
  index,
  onSelect,
}: {
  nodes: Map<string, ExploreNode>;
  index: Connections;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation('graph');
  const [open, setOpen] = useState(true);
  const hubs = useMemo(
    () =>
      [...index.degree]
        .filter(([id]) => !isExternalNode(id))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6),
    [index],
  );
  if (!hubs.length) return null;
  return (
    <aside className="graph-inspector graph-hubs t-caption" aria-label={t('mostConnected')}>
      <button
        type="button"
        className="graph-hubs-heading"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t('mostConnected')}
        <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <>
          <p className="graph-secondary graph-explore-note">{t('exploreHint')}</p>
          {hubs.map(([id, degree]) => (
            <button
              type="button"
              key={id}
              className="graph-hub-row"
              title={id}
              onClick={() => onSelect(id)}
            >
              <span>{nodes.get(id)?.label ?? id}</span>
              <strong>{formatNumber(degree)}</strong>
            </button>
          ))}
          <p className="graph-secondary graph-explore-note">{t('degreeHint')}</p>
        </>
      )}
    </aside>
  );
}
