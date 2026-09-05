/* Ask — chat over the project's index (TRA-312 macOS 26 migration).

   The network layer (sessions, SSE streaming, slash commands) is unchanged;
   what moved is the presentation. Everything this file draws now comes from
   `lattice/ui` and `styles/ask.css`, which reads tokens.css. See DESIGN.md.

   Layout: 220px chat rail · toolbar + thread + composer · 280px context
   inspector (closed by default — it is empty until a message is sent). */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { relativeTime } from '../i18n/format';
import { daemonFetch } from '../daemon-fetch';
import { Icon } from '../lattice/icons';
import { useUsefulPaint } from '../perf';
import {
  Button,
  Card,
  EmptyState,
  IslandHeader,
  Section,
  Skeleton,
  StatusDot,
  Toolbar,
} from '../lattice/ui';
import { parentDir, splitPath } from '../sidebar-prefs.js';
import { useWholeLocation } from '../whole-location.js';

const BASE = 'http://127.0.0.1:3741';

// ── Types ────────────────────────────────────────────────────────────

interface ContextEnvelope {
  symbols: { symbol_id: string; file: string; line: number }[];
  decisions: { id: string; title: string }[];
  files: string[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
  context_envelope?: ContextEnvelope | null;
}

interface Session {
  id: string;
  project_root: string;
  title: string;
  created_at: number;
  last_msg_at: number;
  msg_count: number;
}

type Phase = 'idle' | 'retrieving' | 'streaming' | 'error';

// ── Slash-command definitions ─────────────────────────────────────────

interface SlashCommand {
  name: string;
  /* Syntax, not prose: the parser matches on it and the user types it back
     verbatim, so it is the same in every language. */
  usage: string;
  descriptionKey: string;
  needsArgs: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'find', usage: '/find <query>', descriptionKey: 'slashFind', needsArgs: true },
  { name: 'impact', usage: '/impact <symbol_id>', descriptionKey: 'slashImpact', needsArgs: true },
  { name: 'scan', usage: '/scan', descriptionKey: 'slashScan', needsArgs: false },
];

const SUGGESTION_KEYS = ['suggestionAuth', 'suggestionPlugins', 'suggestionRoutes'];

/** Parse slash command from input. Returns null if not a slash command. */
function parseSlash(input: string): { command: string; args: string } | null {
  if (!input.startsWith('/')) return null;
  const parts = input.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  if (!SLASH_COMMANDS.some((c) => c.name === command)) return null;
  return { command, args };
}

/** Returns matching slash commands for a partial input starting with '/'. */
function matchSlash(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const partial = input.slice(1).split(/\s+/)[0].toLowerCase();
  if (partial === '') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(partial));
}

// ── LocalStorage helpers ─────────────────────────────────────────────

const lastSessionKey = (root: string) => `trace-mcp:current-chat-session-${root}`;
const PANEL_KEY = 'trace-mcp.ask.context-panel';

function loadLastSessionId(root: string): string | null {
  try {
    return localStorage.getItem(lastSessionKey(root));
  } catch {
    return null;
  }
}

function saveLastSessionId(root: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(lastSessionKey(root), id);
    else localStorage.removeItem(lastSessionKey(root));
  } catch {}
}

/** The inspector starts closed: it has nothing in it until a message is sent,
    and 280px of "appears here after you send a message" is not worth it. */
function loadPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === '1';
  } catch {
    return false;
  }
}

// ── Component ────────────────────────────────────────────────────────

export function AskTab({ root }: { root: string }) {
  const { t } = useTranslation('ask');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [streaming, setStreaming] = useState('');
  const [streamingEnvelope, setStreamingEnvelope] = useState<ContextEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [providerReady, setProviderReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen);
  const [loadingSession, setLoadingSession] = useState(false);
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  /* Toolbar scroll-edge hairline — the thread scrolls UNDER the bar, so the
     rule fades in on scroll instead of being painted permanently. */
  const [scrolled, setScrolled] = useState(false);

  /* The thread is the screen. An empty thread with the composer ready is
     useful; a session still loading is not. */
  useUsefulPaint('ask', !loadingSession);

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const ok = provider !== null;
  const busy = phase === 'retrieving' || phase === 'streaming';

  const togglePanel = useCallback(() => {
    setPanelOpen((v) => {
      try {
        localStorage.setItem(PANEL_KEY, v ? '0' : '1');
      } catch {}
      return !v;
    });
  }, []);

  // Provider detection
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await daemonFetch(`${BASE}/api/ask/provider?project=${encodeURIComponent(root)}`);
        if (cancelled || !r.ok) return;
        const d = await r.json();
        if (!cancelled) {
          setProvider(d.provider ?? null);
          setProviderReady(true);
        }
      } catch {
        if (!cancelled) setProviderReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root]);

  // Load sessions list
  const loadSessions = useCallback(async () => {
    try {
      const r = await daemonFetch(`${BASE}/api/ask/sessions?project=${encodeURIComponent(root)}`);
      if (!r.ok) return;
      const d = await r.json();
      setSessions(d.sessions ?? []);
    } catch {}
  }, [root]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Select a session and load its messages
  const selectSession = useCallback(async (id: string) => {
    setActiveSessionId(id);
    saveLastSessionId(root, id);
    setLoadingSession(true);
    setMessages([]);
    setStreaming('');
    setStreamingEnvelope(null);
    setError(null);
    setPhase('idle');
    try {
      const r = await daemonFetch(`${BASE}/api/ask/sessions/${encodeURIComponent(id)}`);
      if (!r.ok) return;
      const d = await r.json();
      setMessages(d.messages ?? []);
    } catch {
      setError(t('loadSessionFailed'));
    } finally {
      setLoadingSession(false);
    }
  }, [root, t]);

  // Restore last session on mount / root change
  useEffect(() => {
    const lastId = loadLastSessionId(root);
    if (lastId) {
      selectSession(lastId);
    } else {
      setActiveSessionId(null);
      setMessages([]);
    }
  }, [root, selectSession]);

  // Scroll to bottom on new messages or streaming
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages and streaming trigger scroll — intentional
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Cleanup abort on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // Create a new session
  const createSession = useCallback(async () => {
    try {
      const r = await daemonFetch(`${BASE}/api/ask/sessions`, { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_root: root, title: t('newChat') }),
      });
      if (!r.ok) return;
      const { id } = await r.json();
      await loadSessions();
      await selectSession(id);
    } catch {}
  }, [root, loadSessions, selectSession, t]);

  // Delete a session
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await daemonFetch(`${BASE}/api/ask/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (activeSessionId === id) {
          setActiveSessionId(null);
          setMessages([]);
          saveLastSessionId(root, null);
        }
        await loadSessions();
      } catch {}
    },
    [activeSessionId, root, loadSessions],
  );

  // Textarea auto-grow
  const grow = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  // Update slash suggestions when input changes
  const updateSlash = useCallback((value: string) => {
    if (value.startsWith('/') && !value.includes('\n')) {
      const matches = matchSlash(value);
      setSlashSuggestions(matches);
      setSlashIndex(0);
    } else {
      setSlashSuggestions([]);
    }
  }, []);

  const prefill = useCallback((value: string) => {
    setInput(value);
    taRef.current?.focus();
  }, []);

  // Send a slash command (POST to /slash endpoint, get JSON back)
  const sendSlash = useCallback(
    async (sessionId: string, command: string, args: string) => {
      setPhase('retrieving');
      setError(null);
      try {
        const r = await daemonFetch(
          `${BASE}/api/ask/sessions/${encodeURIComponent(sessionId)}/slash`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command, args }),
          },
        );
        if (!r.ok) {
          const errBody = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          throw new Error(errBody.error ?? `HTTP ${r.status}`);
        }
        const { id, content } = await r.json();
        setMessages((prev) => [
          ...prev,
          {
            id: id ?? `slash-${Date.now()}`,
            role: 'assistant',
            content,
            created_at: Date.now(),
            context_envelope: null,
          },
        ]);
        setPhase('idle');
        loadSessions();
      } catch (e) {
        setError((e as Error)?.message ?? t('slashFailed'));
        setPhase('error');
      }
    },
    [loadSessions, t],
  );

  // Send a message (or slash command)
  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy || !ok) return;

    // Close slash popup
    setSlashSuggestions([]);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';

    // Check if this is a slash command
    const parsed = parseSlash(q);

    let sessionId = activeSessionId;

    // Auto-create session if none selected
    if (!sessionId) {
      try {
        const r = await daemonFetch(`${BASE}/api/ask/sessions`, { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_root: root, title: q.slice(0, 60) }),
        });
        if (!r.ok) throw new Error(t('createSessionFailed'));
        const { id } = await r.json();
        sessionId = id;
        setActiveSessionId(id);
        saveLastSessionId(root, id);
        await loadSessions();
      } catch (e) {
        setError((e as Error).message ?? t('createSessionFailed'));
        setInput(q);
        return;
      }
    }

    if (!sessionId) {
      setError(t('noSession'));
      setInput(q);
      return;
    }

    // Optimistic user bubble (show for both slash and LLM)
    const optimisticMsg: ChatMessage = {
      id: `opt-${Date.now()}`,
      role: 'user',
      content: q,
      created_at: Date.now(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    setError(null);
    setStreaming('');
    setStreamingEnvelope(null);

    if (parsed) {
      // Slash command path — no SSE, no context_envelope
      await sendSlash(sessionId, parsed.command, parsed.args);
      return;
    }

    // Regular LLM path
    setPhase('retrieving');
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await daemonFetch(
        `${BASE}/api/ask/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: q }),
          signal: ctrl.signal,
        },
      );
      if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`));

      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let acc = '';
      let envelope: ContextEnvelope | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const ln of lines) {
          const t = ln.trim();
          if (!t.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(t.slice(6));
            if (ev.type === 'context_envelope') {
              envelope = ev.envelope as ContextEnvelope;
              setStreamingEnvelope(envelope);
            } else if (ev.type === 'phase' && ev.phase === 'streaming') {
              setPhase('streaming');
            } else if (ev.type === 'chunk' && ev.content) {
              acc += ev.content;
              setStreaming(acc);
              setPhase('streaming');
            } else if (ev.type === 'done') {
              const finalContent = acc;
              acc = '';
              setMessages((prev) => [
                ...prev,
                {
                  id: `a-${Date.now()}`,
                  role: 'assistant',
                  content: finalContent,
                  created_at: Date.now(),
                  context_envelope: envelope,
                },
              ]);
              setStreaming('');
              setStreamingEnvelope(null);
              setPhase('idle');
              // Reload sessions to update title + msg_count
              loadSessions();
            } else if (ev.type === 'error') {
              throw new Error(ev.message);
            }
          } catch (parseErr) {
            const msg = (parseErr as Error).message ?? '';
            if (!msg.includes('JSON')) throw parseErr;
          }
        }
      }

      // Flush if stream ended without done event
      if (acc) {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: acc,
            created_at: Date.now(),
            context_envelope: envelope,
          },
        ]);
        setStreaming('');
        setStreamingEnvelope(null);
        setPhase('idle');
        loadSessions();
      }
    } catch (e) {
      const err = e as Error;
      if (err?.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setError(err?.message ?? t('unknownError'));
      setPhase('error');
      setStreaming('');
      setStreamingEnvelope(null);
      /* Put the question back in the composer: a failed send must not cost the
         user what they typed, and it makes "Send again" a single click. */
      setInput(q);
    } finally {
      abortRef.current = null;
    }
  }, [input, busy, ok, activeSessionId, root, loadSessions, sendSlash, t]);

  const openSettings = useCallback(() => {
    window.electronAPI?.openSettings?.('ai');
  }, []);

  // The envelope to show in the panel is either the streaming one or the last assistant msg's
  const lastAssistantEnvelope =
    streamingEnvelope ??
    [...messages].reverse().find((m) => m.role === 'assistant')?.context_envelope ??
    null;

  // ── No provider → setup CTA ─────────────────────────────────────
  /* Keeps the surface's chrome: this is the first Ask a new install shows, and
     a screen with no toolbar is the very thing TRA-312 set out to remove. No
     rail and no inspector toggle — there is nothing to list or inspect yet. */
  if (providerReady && !ok) {
    return (
      <div className="ask" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <section className="ask-main">
          <Toolbar>
            <span className="ask-toolbar-title">{t('title')}</span>
          </Toolbar>
          <div className="ask-scroll">
            <div className="ask-measure ask-empty">
              <EmptyState
                icon="search"
                title={t('noProviderTitle')}
                subtitle={t('noProviderSubtitle')}
                action={
                  <Button variant="prominent" size="large" onClick={openSettings}>
                    {t('openAiSettings')}
                  </Button>
                }
              />
            </div>
          </div>
        </section>
      </div>
    );
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const title = activeSession?.title?.trim() || t('newChat');
  const providerLabel = !providerReady
    ? t('connectingProvider')
    : (provider ?? t('noProvider'));

  // ── Main layout ───────────────────────────────────────────────────
  return (
    <div className="ask" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {/* ── Chat rail ─────────────────────────────────────────────── */}
      <aside className="ask-rail" aria-label={t('chats')}>
        <div className="ask-rail-head">
          <Button icon="add" onClick={createSession} style={{ width: '100%' }}>
            {t('newChat')}
          </Button>
        </div>

        <div className="ask-rail-list">
          {sessions.length === 0 ? (
            <div className="ws-sb-empty">{t('noChats')}</div>
          ) : (
            sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onSelect={() => selectSession(s.id)}
                onDelete={() => deleteSession(s.id)}
              />
            ))
          )}
        </div>

        {/* Provider state — a dot AND the word, never colour alone. */}
        <div className="ask-rail-foot">
          <StatusDot tone={ok ? 'green' : 'orange'} size={6} />
          <span className="label">{providerLabel}</span>
        </div>
      </aside>

      {/* ── Conversation ──────────────────────────────────────────── */}
      <section className="ask-main">
        <Toolbar scrolled={scrolled}>
          <span className="ask-toolbar-title">{title}</span>
          <span className="flex-1" />
          <Button
            className="ask-inspector-toggle"
            variant="icon"
            icon="dock_to_right"
            active={panelOpen}
            onClick={togglePanel}
            aria-pressed={panelOpen}
            aria-label={panelOpen ? t('hideContextPanel') : t('showContextPanel')}
            title={panelOpen ? t('hideContext') : t('showContext')}
          />
        </Toolbar>

        <div
          className="ask-scroll"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          {loadingSession ? (
            <div className="ask-measure ask-thread" role="status" aria-label={t('loadingChat')}>
              {[0, 1, 2].map((i) => (
                <div key={i} className={`ask-msg ${i % 2 ? 'is-user' : 'is-assistant'}`}>
                  <div className="ask-bubble">
                    <Skeleton width={180 + i * 40} height={13} />
                  </div>
                </div>
              ))}
            </div>
          ) : messages.length === 0 && !streaming && !busy && !error ? (
            <div className="ask-measure ask-empty">
              <EmptyState
                icon="search"
                title={t('emptyTitle')}
                subtitle={t('emptySubtitle')}
              />
              <Section title={t('slashCommands')}>
                <Card>
                  {SLASH_COMMANDS.map((cmd) => (
                    <div key={cmd.name} className="ask-slash-row">
                      <code>{cmd.usage}</code>
                      <span>{t(cmd.descriptionKey)}</span>
                    </div>
                  ))}
                </Card>
              </Section>
              <div className="ask-suggest">
                {SUGGESTION_KEYS.map((key) => (
                  <Button key={key} size="small" onClick={() => prefill(t(key))}>
                    {t(key)}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div
              className="ask-measure ask-thread"
              role="log"
              aria-live="polite"
              aria-label={t('conversation')}
            >
              {messages.map((m) => (
                <Bubble key={m.id} msg={m} />
              ))}

              {streaming && (
                <div className="ask-msg is-assistant">
                  <div className="ask-bubble">
                    <MarkdownBody content={streaming} />
                    <span className="ask-caret" aria-hidden="true" />
                  </div>
                </div>
              )}

              {busy && !streaming && (
                <div className="ask-msg is-assistant">
                  <div className="ask-bubble ask-typing">
                    <span className="ask-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    {phase === 'retrieving' ? t('retrieving') : t('thinking')}
                  </div>
                </div>
              )}

              {error && (
                <div className="ask-error" role="alert">
                  <Icon name="warning" size={14} />
                  <span className="msg">{error}</span>
                  <Button size="small" onClick={send} disabled={!input.trim() || busy}>
                    {t('sendAgain')}
                  </Button>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* ── Composer ────────────────────────────────────────────── */}
        <div className="ask-composer">
          <div className="ask-measure ask-composer-inner">
            {slashSuggestions.length > 0 && (
              <div className="ask-slash-popover" role="listbox" aria-label={t('slashCommands')}>
                {slashSuggestions.map((cmd, i) => (
                  <button
                    type="button"
                    key={cmd.name}
                    role="option"
                    aria-selected={i === slashIndex}
                    className={`ask-slash-item${i === slashIndex ? ' is-active' : ''}`}
                    onClick={() => {
                      setInput(`/${cmd.name}${cmd.needsArgs ? ' ' : ''}`);
                      setSlashSuggestions([]);
                      taRef.current?.focus();
                    }}
                  >
                    <code>/{cmd.name}</code>
                    <span className="desc">{t(cmd.descriptionKey)}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="ask-input">
              <textarea
                ref={taRef}
                value={input}
                aria-label={t('composerLabel')}
                onChange={(e) => {
                  setInput(e.target.value);
                  grow();
                  updateSlash(e.target.value);
                }}
                onKeyDown={(e) => {
                  // Arrow keys navigate slash popup
                  if (slashSuggestions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSlashIndex((i) => (i + 1) % slashSuggestions.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSlashIndex((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
                      return;
                    }
                    if (e.key === 'Tab' || e.key === 'Enter') {
                      e.preventDefault();
                      const chosen = slashSuggestions[slashIndex];
                      if (chosen) {
                        setInput(`/${chosen.name}${chosen.needsArgs ? ' ' : ''}`);
                        setSlashSuggestions([]);
                      }
                      return;
                    }
                    if (e.key === 'Escape') {
                      setSlashSuggestions([]);
                      return;
                    }
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={t('composerPlaceholder')}
                rows={1}
                disabled={!ok}
              />
              {busy ? (
                <Button
                  variant="icon"
                  icon="stop"
                  onClick={() => abortRef.current?.abort()}
                  aria-label={t('stopGenerating')}
                  title={t('stopGenerating')}
                />
              ) : (
                <Button
                  variant="prominent"
                  icon="arrow_upward"
                  iconSize={16}
                  onClick={send}
                  disabled={!input.trim() || !ok}
                  size="large"
                  aria-label={t('sendMessage')}
                  title={t('sendShortcut')}
                  style={{ width: 28, padding: 0 }}
                />
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Context inspector ─────────────────────────────────────── */}
      {panelOpen && (
        <ContextInspector envelope={lastAssistantEnvelope} onClose={togglePanel} />
      )}
    </div>
  );
}

// ── Markdown renderer with copy-to-clipboard code blocks ─────────────

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const { t } = useTranslation('ask');
  const [copied, setCopied] = useState(false);
  const code = typeof children === 'string' ? children : String(children ?? '');

  const copy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [code]);

  return (
    <div className="ask-code">
      <pre>
        <code className={className}>{code}</code>
      </pre>
      <Button
        className="ask-copy"
        variant="icon"
        icon={copied ? 'check' : 'content_copy'}
        onClick={copy}
        aria-label={copied ? t('copied') : t('copyCode')}
        title={copied ? t('copied') : t('copyCode')}
      />
    </div>
  );
}

function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="ask-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown v9: block code lives inside a <pre> node in the hast tree.
          // The `pre` override receives the block code child; we render CodeBlock there.
          // The `code` override is only reached for inline code (not wrapped in <pre>).
          pre({ children }) {
            // children is the <code> element from react-markdown — unwrap and render as CodeBlock.
            // biome-ignore lint/suspicious/noExplicitAny: react-markdown child is untyped
            const codeEl = children as any;
            const className = codeEl?.props?.className ?? '';
            const content = String(codeEl?.props?.children ?? '').replace(/\n$/, '');
            return <CodeBlock className={className}>{content}</CodeBlock>;
          },
          table({ children }) {
            return (
              <div className="ask-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ── Context inspector ────────────────────────────────────────────────

function ContextInspector({
  envelope,
  onClose,
}: {
  envelope: ContextEnvelope | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('ask');
  // Same rule as the sidebar's file list: a path row shows its location whole
  // or not at all (TRA-504). The inspector narrows with the window.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useWholeLocation(bodyRef);
  return (
    <aside className="ask-inspector" aria-label={t('context')}>
      <IslandHeader
        title={t('context')}
        actions={
          <Button
            variant="icon"
            icon="close"
            onClick={onClose}
            aria-label={t('hideContextPanel')}
            title={t('hideContext')}
          />
        }
      />
      <div className="ask-inspector-body" ref={bodyRef}>
        {!envelope ? (
          <EmptyState
            compact
            icon="description"
            title={t('noContextTitle')}
            subtitle={t('noContextSubtitle')}
          />
        ) : (
          <>
            <Section title={t('filesRead')} count={envelope.files.length}>
              {envelope.files.length === 0 ? (
                <EmptyState compact>{t('noFilesRead')}</EmptyState>
              ) : (
                <div className="ask-rows">
                  {envelope.files.map((f) => (
                    <PathRow
                      key={f}
                      path={f}
                      onClick={() => window.electronAPI?.openInEditor?.(f)}
                    />
                  ))}
                </div>
              )}
            </Section>

            {envelope.symbols.length > 0 && (
              <Section title={t('symbolsRead')} count={envelope.symbols.length}>
                <div className="ask-rows">
                  {envelope.symbols.map((s) => (
                    <button
                      key={s.symbol_id}
                      type="button"
                      className="ws-sb-row"
                      title={s.symbol_id}
                      onClick={() => window.electronAPI?.openInEditor?.(s.file)}
                    >
                      <span className="ws-sb-ico" aria-hidden="true">
                        <Icon name="function" size={16} />
                      </span>
                      <span className="ws-sb-label">
                        {s.symbol_id.split(':').pop() ?? s.symbol_id}
                      </span>
                    </button>
                  ))}
                </div>
              </Section>
            )}

            {envelope.decisions.length > 0 && (
              <Section title={t('decisionsConsulted')} count={envelope.decisions.length}>
                <div className="ask-rows">
                  {envelope.decisions.map((d) => (
                    <div key={d.id} className="ws-sb-row is-static" title={d.title}>
                      <span className="ws-sb-ico" aria-hidden="true">
                        <Icon name="history" size={16} />
                      </span>
                      <span className="ws-sb-label">{d.title}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** One 28px row showing the filename, then its parent directory in secondary
    text — the location is what truncates, never the name (DESIGN.md §4). */
function PathRow({ path, onClick }: { path: string; onClick: () => void }) {
  const { name } = splitPath(path);
  const parent = parentDir(path);
  return (
    <button type="button" className="ws-sb-row" title={path} onClick={onClick}>
      <span className="ws-sb-ico" aria-hidden="true">
        <Icon name="description" size={16} />
      </span>
      <span className="ws-sb-path">
        <span className="name">{name}</span>
        {parent && <span className="dir">{parent}</span>}
      </span>
    </button>
  );
}

// ── Chat rail row ─────────────────────────────────────────────────────

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('ask');
  return (
    <button
      type="button"
      className={`ws-sb-row${active ? ' is-selected' : ''}`}
      aria-current={active ? 'true' : undefined}
      title={session.title || t('untitled')}
      onClick={onSelect}
      // Keyboard route for the delete affordance — the row is itself a button,
      // so the ✕ inside it cannot be one (nested interactive content).
      onKeyDown={(e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();
        onDelete();
      }}
    >
      <span className="ws-sb-label">{session.title || t('untitled')}</span>
      <span className="ws-sb-count">
        {relativeTime(session.last_msg_at, Date.now(), 'short')}
      </span>
      <span
        className="ws-sb-trailing"
        aria-hidden="true"
        title={t('deleteChat')}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="close" size={12} />
      </span>
    </button>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function Bubble({ msg }: { msg: ChatMessage }) {
  const user = msg.role === 'user';
  return (
    <div className={`ask-msg ${user ? 'is-user' : 'is-assistant'}`}>
      <div className="ask-bubble">
        {user ? msg.content : <MarkdownBody content={msg.content} />}
      </div>
    </div>
  );
}
