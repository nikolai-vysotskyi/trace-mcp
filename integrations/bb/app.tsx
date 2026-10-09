import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { definePluginApp, useRpc, type PluginRpcResult } from '@get-bb/plugin-sdk/app';
import type { traceUiRpcContract } from './ui-contract.js';
import './app.css';

type Overview = PluginRpcResult<(typeof traceUiRpcContract)['readOverview']>;

const DECISION_TYPES = [
  ['architecture_decision', 'Architecture'],
  ['tech_choice', 'Technical choice'],
  ['bug_root_cause', 'Bug root cause'],
  ['preference', 'Preference'],
  ['tradeoff', 'Tradeoff'],
  ['discovery', 'Discovery'],
  ['convention', 'Convention'],
] as const;
type DecisionType = (typeof DECISION_TYPES)[number][0];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readableType(type: string): string {
  return DECISION_TYPES.find(([value]) => value === type)?.[1] ?? type.replaceAll('_', ' ');
}

function TraceContextPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof traceUiRpcContract>();
  const request = useRef(0);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<DecisionType>('tech_choice');
  const [saving, setSaving] = useState(false);
  const [indexing, setIndexing] = useState(false);

  const load = useCallback(
    async (query: string) => {
      const current = ++request.current;
      setLoading(true);
      setError(null);
      try {
        const next = await rpc.call('readOverview', {
          threadId,
          ...(query.trim() ? { search: query.trim() } : {}),
        });
        if (current === request.current) setOverview(next);
      } catch (cause) {
        if (current === request.current) setError(message(cause));
      } finally {
        if (current === request.current) setLoading(false);
      }
    },
    [rpc, threadId],
  );

  useEffect(() => {
    void load('');
    return () => {
      request.current += 1;
    };
  }, [load]);

  async function saveDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await rpc.call('saveDecision', {
        threadId,
        title: title.trim(),
        content: content.trim(),
        type,
      });
      setTitle('');
      setContent('');
      setShowForm(false);
      setNotice('Decision recorded.');
      await load(submittedSearch);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function indexRepository() {
    setIndexing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.call('reindex', { threadId });
      setNotice(
        result.errors > 0
          ? `Indexed ${result.indexed} files with ${result.errors} errors.`
          : `Indexed ${result.indexed} files.`,
      );
      await load(submittedSearch);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setIndexing(false);
    }
  }

  const index = overview?.index;
  const context = overview?.context;
  const contextPercent = context
    ? Math.min(100, Math.round((100 * context.usedTokens) / context.modelContextWindow))
    : 0;

  return (
    <div className="trace-context-panel">
      <div className="trace-panel-actions">
        <span className="trace-eyebrow">Repository context</span>
        <button
          aria-label="Refresh trace context"
          className="trace-text-button"
          disabled={loading}
          onClick={() => void load(submittedSearch)}
          type="button"
        >
          Refresh
        </button>
      </div>

      {error ? (
        <p className="trace-alert" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="trace-notice" role="status">
          {notice}
        </p>
      ) : null}

      <section aria-label="Repository index" className="trace-section">
        <div className="trace-section-heading">
          <h2>Index</h2>
          <span className="trace-index-status">
            {index?.status ?? (loading ? 'Loading' : 'Unavailable')}
          </span>
        </div>
        {overview?.indexError ? (
          <p className="trace-secondary">Index status unavailable: {overview.indexError}</p>
        ) : null}
        <div className="trace-stats">
          <div>
            <strong>{index ? index.files.toLocaleString() : '—'}</strong>
            <span>files</span>
          </div>
          <div>
            <strong>{index ? index.symbols.toLocaleString() : '—'}</strong>
            <span>symbols</span>
          </div>
        </div>
        {index?.warnings.map((warning) => (
          <p className="trace-secondary" key={warning}>
            {warning}
          </p>
        ))}
        <button
          className="trace-secondary-button"
          disabled={indexing || loading}
          onClick={() => void indexRepository()}
          type="button"
        >
          {indexing ? 'Indexing…' : index?.files ? 'Reindex repository' : 'Index repository'}
        </button>
      </section>

      <section aria-label="Context window" className="trace-section">
        <div className="trace-section-heading">
          <h2>Context window</h2>
          {context ? <strong>{contextPercent}%</strong> : null}
        </div>
        {context ? (
          <>
            <div
              aria-label="Context window usage"
              aria-valuemax={context.modelContextWindow}
              aria-valuemin={0}
              aria-valuenow={Math.min(context.usedTokens, context.modelContextWindow)}
              className="trace-meter"
              role="progressbar"
            >
              <span style={{ width: `${contextPercent}%` }} />
            </div>
            <p className="trace-secondary">
              {context.usedTokens.toLocaleString()} of {context.modelContextWindow.toLocaleString()}{' '}
              tokens used{context.estimated ? ' · estimated by provider' : ''}
            </p>
          </>
        ) : (
          <p className="trace-secondary">
            {loading && overview === null
              ? 'Loading context usage…'
              : 'This provider has not reported context usage yet.'}
          </p>
        )}
      </section>

      <section aria-label="Project decisions" className="trace-section">
        <div className="trace-section-heading">
          <h2>Project decisions</h2>
          <span className="trace-count">{overview?.decisions.length ?? 0}</span>
        </div>
        <form
          className="trace-search"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedSearch(search);
            void load(search);
          }}
        >
          <label className="trace-visually-hidden" htmlFor="trace-decision-search">
            Search decisions
          </label>
          <input
            id="trace-decision-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search decisions"
            type="search"
            value={search}
          />
          <button disabled={loading} type="submit">
            Search
          </button>
        </form>
        {overview?.decisionsError ? (
          <p className="trace-alert" role="alert">
            Decisions unavailable: {overview.decisionsError}
          </p>
        ) : null}
        {overview?.decisions.length ? (
          <ul className="trace-decision-list">
            {overview.decisions.map((decision) => (
              <li key={decision.id}>
                <strong>{decision.title}</strong>
                <span>{readableType(decision.type)}</span>
                {decision.summary ? <p>{decision.summary}</p> : null}
              </li>
            ))}
          </ul>
        ) : !loading && !overview?.decisionsError ? (
          <p className="trace-secondary">
            {submittedSearch
              ? 'No decisions match this search.'
              : 'No project decisions saved yet.'}
          </p>
        ) : null}
        <button
          aria-expanded={showForm}
          className="trace-secondary-button"
          onClick={() => setShowForm((open) => !open)}
          type="button"
        >
          {showForm ? 'Cancel' : 'Record decision'}
        </button>
        {showForm ? (
          <form className="trace-decision-form" onSubmit={(event) => void saveDecision(event)}>
            <label>
              Decision title
              <input
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                required
                value={title}
              />
            </label>
            <label>
              Type
              <select
                onChange={(event) => {
                  const next = DECISION_TYPES.find(([value]) => value === event.target.value);
                  if (next) setType(next[0]);
                }}
                value={type}
              >
                {DECISION_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reason and tradeoffs
              <textarea
                maxLength={5000}
                onChange={(event) => setContent(event.target.value)}
                required
                rows={4}
                value={content}
              />
            </label>
            <button disabled={saving || !title.trim() || !content.trim()} type="submit">
              {saving ? 'Saving…' : 'Save decision'}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: 'trace-context',
    title: 'Trace context',
    component: TraceContextPanel,
  });
});
