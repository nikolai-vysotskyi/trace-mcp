/**
 * Benchmark Lab — measured comparisons, run in the app (TRA-1951).
 *
 * Pick arms (file-reading control, minimal, standard), run the pinned
 * battery against the selected project's index, read the table, export the
 * markdown the docs pages quote. The renderer computes nothing: `POST
 * /api/benchmark-lab/run` measures, persists to `~/benchmark-runs`, and
 * returns the record every table below prints from.
 *
 * Four states, all designed, none of them a spinner:
 *   loading  — skeleton rows at the final geometry
 *   failed   — the daemon is down, with its restart affordance
 *   no runs  — an empty state that explains the first run
 *   results  — the aggregate table, per-fixture rows, history, export
 * While a run is in flight the setup card shows an honest running state:
 * the battery executes in one daemon call, so there is no per-fixture
 * progress to report — only that it is running and for how long.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DaemonDownPane } from '../components/DaemonDownPane';
import { BASE, DAEMON_TOOL_TIMEOUT_MS, daemonFetch } from '../daemon-fetch';
import { useDaemon } from '../hooks/useDaemon';
import { formatNumber } from '../i18n/format';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ListRow,
  Section,
  SkeletonRows,
  Toolbar,
} from '../lattice/ui';
import { useUsefulPaint } from '../perf';

interface LabArm {
  id: string;
  label: string;
  description: string;
  tools: string[];
}

interface LabFixtureInfo {
  id: string;
  kind: string;
  query: string;
  k: number;
}

interface LabArmMeasurement {
  calls: number;
  tokens: number;
  success: boolean;
  ms: number;
  recall_at_k: number | null;
  note?: string;
}

interface LabArmAggregate {
  arm: string;
  fixtures: number;
  success_count: number;
  success_rate: number;
  total_tokens: number;
  total_calls: number;
  total_ms: number;
  median_tokens_per_fixture: number;
  savings_vs_baseline_pct: number | null;
  cost_usd: number;
}

interface LabRun {
  schema_version: number;
  run_id: string;
  started_at: string;
  finished_at: string;
  project_root: string;
  battery: { source: string; fixtures_sha: string; fixture_count: number };
  measured_build: { version: string; commit: string; dirty?: boolean };
  model: { name: string; input_usd_per_mtok: number };
  arms: string[];
  results: {
    fixture_id: string;
    kind: string;
    query: string;
    k: number;
    baseline: number;
    arms: Record<string, LabArmMeasurement | undefined>;
  }[];
  aggregates: LabArmAggregate[];
}

interface LabRunSummary {
  run_id: string;
  file: string;
  started_at: string;
  project_root: string;
  fixture_count: number;
  fixtures_sha: string;
  arms: string[];
  build: string;
  aggregates: LabArmAggregate[];
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${formatNumber(Math.round(n / 100_000) / 10)}M`;
  if (n >= 10_000) return `${formatNumber(Math.round(n / 1_000))}K`;
  return formatNumber(n);
}

function savingsCell(savings: number | null, controlNote: string): string {
  if (savings === null) return `— (${controlNote})`;
  const sign = savings > 0 ? '−' : '+';
  return `${sign}${Math.abs(savings).toFixed(1)}%`;
}

type Timer = ReturnType<typeof setInterval>;

export function BenchmarkLab() {
  const { t } = useTranslation('benchmarklab');
  const { projects, restarting, restartDaemon } = useDaemon();
  const [arms, setArms] = useState<LabArm[] | null>(null);
  const [fixtures, setFixtures] = useState<LabFixtureInfo[] | null>(null);
  const [runs, setRuns] = useState<LabRunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const [project, setProject] = useState<string | null>(null);
  const [pickedArms, setPickedArms] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LabRun | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const runTimer = useRef<Timer | null>(null);

  const load = useCallback(async () => {
    try {
      const [armsRes, fixturesRes, runsRes] = await Promise.all([
        daemonFetch(`${BASE}/api/benchmark-lab/arms`),
        daemonFetch(`${BASE}/api/benchmark-lab/fixtures`),
        daemonFetch(`${BASE}/api/benchmark-lab/runs`),
      ]);
      if (!armsRes.ok || !fixturesRes.ok || !runsRes.ok) throw new Error('lab endpoints');
      const armsJson = (await armsRes.json()) as { arms: LabArm[] };
      const fixturesJson = (await fixturesRes.json()) as { fixtures: LabFixtureInfo[] };
      const runsJson = (await runsRes.json()) as { runs: LabRunSummary[] };
      setArms(armsJson.arms);
      setPickedArms((prev) => (prev.length === 0 ? armsJson.arms.map((a) => a.id) : prev));
      setFixtures(fixturesJson.fixtures);
      setRuns(runsJson.runs);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (runTimer.current) clearInterval(runTimer.current);
    };
  }, []);

  // Default the project picker to the first registered project.
  useEffect(() => {
    if (project === null && projects.length > 0) setProject(projects[0].root);
  }, [projects, project]);

  const loaded = arms !== null && fixtures !== null && runs !== null;
  useUsefulPaint('benchmark-lab', loaded || failed);

  const openRun = useCallback(async (id: string) => {
    try {
      const res = await daemonFetch(`${BASE}/api/benchmark-lab/runs?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { run: LabRun };
      setSelected(json.run);
      setMarkdown(null);
      setCopied(false);
    } catch {
      setRunError(id);
    }
  }, []);

  const startRun = useCallback(async () => {
    if (running || pickedArms.length === 0) return;
    setRunning(true);
    setRunError(null);
    setMarkdown(null);
    const t0 = Date.now();
    setElapsed(0);
    runTimer.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    try {
      const res = await daemonFetch(
        `${BASE}/api/benchmark-lab/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: project ?? undefined, arms: pickedArms }),
        },
        DAEMON_TOOL_TIMEOUT_MS,
      );
      const json = (await res.json().catch(() => ({}))) as { run?: LabRun; error?: string };
      if (!res.ok || !json.run) throw new Error(json.error ?? `HTTP ${res.status}`);
      const run = json.run;
      setSelected(run);
      setRuns((prev) =>
        prev === null
          ? prev
          : [
              {
                run_id: run.run_id,
                file: '',
                started_at: run.started_at,
                project_root: run.project_root,
                fixture_count: run.battery.fixture_count,
                fixtures_sha: run.battery.fixtures_sha,
                arms: run.arms,
                build: `${run.measured_build.version}@${run.measured_build.commit}`,
                aggregates: run.aggregates,
              },
              ...prev,
            ],
      );
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runTimer.current) clearInterval(runTimer.current);
      runTimer.current = null;
      setRunning(false);
    }
  }, [running, pickedArms, project]);

  const exportMarkdown = useCallback(async () => {
    if (!selected) return;
    try {
      const res = await daemonFetch(
        `${BASE}/api/benchmark-lab/export?id=${encodeURIComponent(selected.run_id)}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      setMarkdown(await res.text());
      setCopied(false);
    } catch {
      setRunError(selected.run_id);
    }
  }, [selected]);

  const copyMarkdown = useCallback(async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
    } catch {
      // Clipboard needs a focused document; the <pre> below stays selectable.
    }
  }, [markdown]);

  const toggleArm = useCallback((id: string, on: boolean) => {
    setPickedArms((prev) => (on ? [...prev, id] : prev.filter((a) => a !== id)));
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar scrolled={scrolled} className="gap-3">
        <h2
          className="flex-1 min-w-0 text-[15px] leading-5 font-semibold truncate"
          style={{ color: 'var(--label)', letterSpacing: '-0.01em' }}
        >
          {t('title')}
        </h2>
        <Button
          variant="icon"
          icon="refresh"
          onClick={() => void load()}
          aria-label={t('refresh')}
          title={t('refresh')}
        />
      </Toolbar>

      <div
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        {failed ? (
          <div className="flex items-center justify-center h-full">
            <DaemonDownPane restarting={restarting} onRestart={() => void restartDaemon()} />
          </div>
        ) : (
          <div className="flex flex-col gap-6 px-4 py-4 mx-auto w-full" style={{ maxWidth: 720 }}>
            {!loaded || arms === null || fixtures === null || runs === null ? (
              <Card>
                <SkeletonRows rows={5} />
              </Card>
            ) : (
              <>
                <Section title={t('sectionSetup')}>
                  <Card>
                    <div className="flex flex-col gap-3 px-3 py-3">
                      <label
                        className="flex flex-col gap-1 text-[13px] leading-[18px]"
                        style={{ color: 'var(--label-secondary)' }}
                      >
                        {t('projectLabel')}
                        {projects.length === 0 ? (
                          <span
                            className="text-[13px] leading-[18px]"
                            style={{ color: 'var(--status-orange)' }}
                          >
                            {t('noProjects')}
                          </span>
                        ) : (
                          <select
                            value={project ?? ''}
                            onChange={(e) => setProject(e.target.value)}
                            disabled={running}
                            className="text-[13px] leading-[18px] rounded-md px-2 py-1"
                            style={{
                              color: 'var(--label)',
                              background: 'var(--fill-tertiary)',
                              border: '0.5px solid var(--separator)',
                            }}
                          >
                            {projects.map((p) => (
                              <option key={p.root} value={p.root}>
                                {p.root}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                      <div className="flex flex-col gap-2">
                        <span
                          className="text-[13px] leading-[18px]"
                          style={{ color: 'var(--label-secondary)' }}
                        >
                          {t('armsLabel')} ·{' '}
                          {t('batteryNote', {
                            count: fixtures.length,
                            arms: pickedArms.length,
                          })}
                        </span>
                        {arms.map((arm) => (
                          <label
                            key={arm.id}
                            className="flex items-start gap-2 text-[13px] leading-[18px]"
                            style={{ color: 'var(--label)' }}
                          >
                            <Checkbox
                              checked={pickedArms.includes(arm.id)}
                              onChange={(next) => toggleArm(arm.id, next)}
                              aria-label={arm.label}
                              disabled={running}
                            />
                            <span>
                              <span className="font-medium">{arm.label}</span>
                              <span style={{ color: 'var(--label-secondary)' }}>
                                {' '}
                                — {arm.description}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <div className="flex items-center gap-3">
                        <Button
                          variant="prominent"
                          onClick={() => void startRun()}
                          disabled={running || pickedArms.length === 0 || projects.length === 0}
                        >
                          {running ? t('running') : t('run')}
                        </Button>
                        {running && (
                          <span
                            className="text-[13px] leading-[18px] tabular-nums"
                            style={{ color: 'var(--label-secondary)' }}
                            role="status"
                          >
                            {t('runningNote')} ({elapsed}s)
                          </span>
                        )}
                      </div>
                      {runError && (
                        <p className="text-[13px] leading-[18px]" style={{ color: 'var(--status-red)' }}>
                          {t('runFailed')}: {runError}
                        </p>
                      )}
                    </div>
                  </Card>
                </Section>

                {selected ? (
                  <LabResult
                    run={selected}
                    markdown={markdown}
                    copied={copied}
                    onExport={() => void exportMarkdown()}
                    onCopy={() => void copyMarkdown()}
                  />
                ) : (
                  /* No second Run button here: the setup card above already
                     carries the one default action (HIG: one per region). */
                  <EmptyState
                    icon="monitoring"
                    title={t('noRunsTitle')}
                    subtitle={runs.length > 0 ? undefined : t('noRunsSubtitle')}
                  />
                )}

                {runs.length > 0 && (
                  <Section title={t('sectionHistory')}>
                    <Card>
                      {runs.map((r, i) => (
                        <ListRow
                          key={r.run_id}
                          label={`${r.started_at.slice(0, 10)} · ${r.build} · ${r.arms.join('+')}`}
                          value={`${r.fixture_count} fixtures`}
                          last={i === runs.length - 1}
                        />
                      ))}
                    </Card>
                    <div className="flex flex-wrap gap-2 px-1">
                      {runs.slice(0, 5).map((r) => (
                        <Button key={r.run_id} size="small" onClick={() => void openRun(r.run_id)}>
                          {r.run_id}
                        </Button>
                      ))}
                    </div>
                  </Section>
                )}

                <Section title={t('sectionMethod')}>
                  <Card>
                    <p
                      className="px-3 py-3 text-[13px] leading-[18px]"
                      style={{ color: 'var(--label-secondary)' }}
                    >
                      {t('methodBody')}
                    </p>
                  </Card>
                </Section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LabResult({
  run,
  markdown,
  copied,
  onExport,
  onCopy,
}: {
  run: LabRun;
  markdown: string | null;
  copied: boolean;
  onExport: () => void;
  onCopy: () => void;
}) {
  const { t } = useTranslation('benchmarklab');
  return (
    <Section title={t('sectionResults')}>
      <Card>
        <div className="px-3 py-3 overflow-x-auto">
          <table className="w-full text-[13px] leading-[18px]" style={{ color: 'var(--label)' }}>
            <thead>
              <tr style={{ color: 'var(--label-secondary)' }}>
                <th className="text-left font-semibold pb-2 pr-3">{t('tableArm')}</th>
                <th className="text-right font-semibold pb-2 pr-3 tabular-nums">{t('tableTokens')}</th>
                <th className="text-right font-semibold pb-2 pr-3 tabular-nums">{t('tableCalls')}</th>
                <th className="text-right font-semibold pb-2 pr-3 tabular-nums">{t('tableSuccess')}</th>
                <th className="text-right font-semibold pb-2 pr-3 tabular-nums">{t('tableSavings')}</th>
                <th className="text-right font-semibold pb-2 tabular-nums">{t('tableCost')}</th>
              </tr>
            </thead>
            <tbody>
              {run.aggregates.map((a) => (
                <tr key={a.arm} className="border-t" style={{ borderColor: 'var(--separator)' }}>
                  <td className="py-2 pr-3 font-medium">{a.arm}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{compact(a.total_tokens)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(a.total_calls)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {a.success_count}/{a.fixtures}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {savingsCell(a.savings_vs_baseline_pct, t('controlNote'))}
                  </td>
                  <td className="py-2 text-right tabular-nums">${a.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p
            className="pt-3 text-[11px] leading-[15px]"
            style={{ color: 'var(--label-secondary)' }}
          >
            {t('provenance', {
              date: run.started_at.slice(0, 10),
              build: `${run.measured_build.version}@${run.measured_build.commit}`,
              sha: run.battery.fixtures_sha,
            })}
          </p>
        </div>
      </Card>
      <Card>
        <div className="px-3 py-3 overflow-x-auto">
          <table className="w-full text-[12px] leading-[16px]" style={{ color: 'var(--label)' }}>
            <thead>
              <tr style={{ color: 'var(--label-secondary)' }}>
                <th className="text-left font-semibold pb-2 pr-3">{t('tableFixture')}</th>
                {run.arms.map((arm) => (
                  <th key={arm} className="text-right font-semibold pb-2 pr-3 tabular-nums last:pr-0">
                    {arm}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {run.results.map((r) => (
                <tr
                  key={r.fixture_id}
                  className="border-t"
                  style={{ borderColor: 'var(--separator)' }}
                >
                  <td className="py-1.5 pr-3">
                    {r.fixture_id}{' '}
                    <span style={{ color: 'var(--label-secondary)' }}>· {r.kind}</span>
                  </td>
                  {run.arms.map((arm, i) => {
                    const m = r.arms[arm];
                    return (
                      <td
                        key={arm}
                        className={`py-1.5 text-right tabular-nums ${i === run.arms.length - 1 ? '' : 'pr-3'}`}
                      >
                        {m ? `${compact(m.tokens)}/${m.success ? '✓' : '✗'}` : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="flex items-center gap-2 px-1">
        <Button size="small" onClick={onExport}>
          {t('exportMarkdown')}
        </Button>
        {markdown && (
          <Button size="small" onClick={onCopy}>
            {copied ? t('copied') : t('copyMarkdown')}
          </Button>
        )}
      </div>
      {markdown && (
        <Card>
          <pre
            className="px-3 py-3 text-[12px] leading-[16px] overflow-x-auto whitespace-pre-wrap"
            style={{ color: 'var(--label)' }}
          >
            {markdown}
          </pre>
        </Card>
      )}
    </Section>
  );
}
