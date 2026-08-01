import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  usage: string;
  description: string;
  needsArgs: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'find', usage: '/find <query>', description: 'Search symbols by name', needsArgs: true },
  { name: 'impact', usage: '/impact <symbol_id>', description: 'Show change impact for a symbol', needsArgs: true },
  { name: 'scan', usage: '/scan', description: 'Run security scan (OWASP top findings)', needsArgs: false },
];

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

// ── Component ────────────────────────────────────────────────────────

export function AskTab({ root }: { root: string }) {
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
  const [panelOpen, setPanelOpen] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const ok = provider !== null;
  const busy = phase === 'retrieving' || phase === 'streaming';

  // Provider detection
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/ask/provider?project=${encodeURIComponent(root)}`);
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
      const r = await fetch(`${BASE}/api/ask/sessions?project=${encodeURIComponent(root)}`);
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
      const r = await fetch(`${BASE}/api/ask/sessions/${encodeURIComponent(id)}`);
      if (!r.ok) return;
      const d = await r.json();
      setMessages(d.messages ?? []);
    } catch {
      setError('Failed to load session');
    } finally {
      setLoadingSession(false);
    }
  }, [root]);

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
      const r = await fetch(`${BASE}/api/ask/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_root: root, title: 'New chat' }),
      });
      if (!r.ok) return;
      const { id } = await r.json();
      await loadSessions();
      await selectSession(id);
    } catch {}
  }, [root, loadSessions, selectSession]);

  // Delete a session
  const deleteSession = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await fetch(`${BASE}/api/ask/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

  // Send a slash command (POST to /slash endpoint, get JSON back)
  const sendSlash = useCallback(
    async (sessionId: string, command: string, args: string) => {
      setPhase('retrieving');
      setError(null);
      try {
        const r = await fetch(
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
        setError((e as Error)?.message ?? 'Slash command failed');
        setPhase('error');
      }
    },
    [loadSessions],
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
        const r = await fetch(`${BASE}/api/ask/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_root: root, title: q.slice(0, 60) }),
        });
        if (!r.ok) throw new Error('Failed to create session');
        const { id } = await r.json();
        sessionId = id;
        setActiveSessionId(id);
        saveLastSessionId(root, id);
        await loadSessions();
      } catch (e) {
        setError((e as Error).message ?? 'Failed to create session');
        return;
      }
    }

    if (!sessionId) {
      setError('Could not establish a chat session');
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
      const r = await fetch(
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
      setError(err?.message ?? 'Unknown error');
      setPhase('error');
      setStreaming('');
      setStreamingEnvelope(null);
    } finally {
      abortRef.current = null;
    }
  }, [input, busy, ok, activeSessionId, root, loadSessions, sendSlash]);

  const openSettings = useCallback(() => {
    window.electronAPI?.openSettings?.('ai');
  }, []);

  // The envelope to show in the panel is either the streaming one or the last assistant msg's
  const lastAssistantEnvelope =
    streamingEnvelope ??
    [...messages].reverse().find((m) => m.role === 'assistant')?.context_envelope ??
    null;

  // ── No provider → setup CTA ─────────────────────────────────────
  if (providerReady && !ok) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full"
        style={{ WebkitAppRegion: 'no-drag', gap: 20 } as React.CSSProperties}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            background: 'var(--fill-control)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '0.5px solid var(--border)',
            boxShadow: 'var(--shadow-grouped)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-tertiary)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--text-primary)',
              letterSpacing: '-0.2px',
            }}
          >
            Connect an AI provider
          </div>
          <div
            style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, lineHeight: '1.5' }}
          >
            Required for Ask to work
          </div>
        </div>
        <button
          onClick={openSettings}
          type="button"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: '#fff',
            background: 'var(--accent)',
            border: 'none',
            borderRadius: 8,
            padding: '8px 24px',
            cursor: 'pointer',
            boxShadow: 'var(--shadow-control)',
            letterSpacing: '-0.1px',
          }}
        >
          AI Settings...
        </button>
      </div>
    );
  }

  // ── Main layout ───────────────────────────────────────────────────
  return (
    <div
      className="flex h-full"
      style={{ WebkitAppRegion: 'no-drag', overflow: 'hidden' } as React.CSSProperties}
    >
      {/* ── Sessions sidebar (240px) ─────────────────────────────── */}
      <div
        style={{
          width: 240,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '0.5px solid var(--border)',
          background: 'var(--bg-sidebar, var(--bg-grouped))',
          overflow: 'hidden',
        }}
      >
        {/* Sidebar header */}
        <div
          style={{
            padding: '10px 10px 6px',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={createSession}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 10px',
              borderRadius: 8,
              background: 'var(--fill-control)',
              border: '0.5px solid var(--border)',
              boxShadow: 'var(--shadow-control)',
              color: 'var(--text-primary)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <line x1="6" y1="1" x2="6" y2="11" />
              <line x1="1" y1="6" x2="11" y2="6" />
            </svg>
            New chat
          </button>
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 6px 8px' }}>
          {sessions.length === 0 && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-tertiary)',
                textAlign: 'center',
                padding: '20px 8px',
              }}
            >
              No chats yet
            </div>
          )}
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onSelect={() => selectSession(s.id)}
              onDelete={(e) => deleteSession(s.id, e)}
            />
          ))}
        </div>

        {/* Provider status */}
        <div
          style={{
            flexShrink: 0,
            padding: '6px 10px',
            borderTop: '0.5px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: ok ? 'var(--success)' : 'var(--text-tertiary)',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {!providerReady ? 'Connecting...' : (provider ?? 'No provider')}
          </span>
        </div>
      </div>

      {/* ── Chat area (flex-1) ───────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Messages */}
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          style={{ padding: '0 2px' }}
        >
          {/* Empty / no session state — shows slash-command hint card */}
          {!activeSessionId && !loadingSession && (
            <div className="flex flex-col items-center justify-center h-full" style={{ gap: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                  textAlign: 'center',
                  maxWidth: 240,
                }}
              >
                Ask anything about this codebase
              </div>
              {/* Slash-command hint card */}
              <div
                style={{
                  background: 'var(--fill-control)',
                  border: '0.5px solid var(--border)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  maxWidth: 300,
                  width: '100%',
                }}
              >
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                  Slash commands
                </div>
                {SLASH_COMMANDS.map((cmd) => (
                  <div
                    key={cmd.name}
                    style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}
                  >
                    <code
                      style={{
                        fontSize: 10,
                        color: 'var(--accent)',
                        background: 'rgba(0,122,255,0.08)',
                        borderRadius: 4,
                        padding: '1px 5px',
                        flexShrink: 0,
                        fontFamily: 'monospace',
                      }}
                    >
                      {cmd.usage}
                    </code>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                      {cmd.description}
                    </span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'center',
                  gap: 6,
                  maxWidth: 340,
                }}
              >
                {['How does auth work?', 'Explain the plugin system', 'Where are API routes?'].map(
                  (q) => (
                    <button
                      type="button"
                      key={q}
                      onClick={() => {
                        setInput(q);
                        taRef.current?.focus();
                      }}
                      style={{
                        fontSize: 10,
                        padding: '5px 10px',
                        borderRadius: 8,
                        background: 'var(--fill-control)',
                        backdropFilter: 'blur(12px)',
                        WebkitBackdropFilter: 'blur(12px)',
                        border: '0.5px solid var(--border)',
                        boxShadow: 'var(--shadow-control)',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      {q}
                    </button>
                  ),
                )}
              </div>
            </div>
          )}

          {loadingSession && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
              }}
            >
              <Dots />
            </div>
          )}

          {/* Bubbles */}
          {messages.map((m) => (
            <Bubble key={m.id} msg={m} />
          ))}

          {/* Streaming bubble */}
          {streaming && (
            <div style={{ display: 'flex', padding: '3px 2px' }}>
              <div style={{ ...assistantStyle, maxWidth: '88%' }}>
                <MarkdownBody content={streaming} />
                <span
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 14,
                    marginLeft: 2,
                    borderRadius: 2,
                    background: 'var(--accent)',
                    verticalAlign: 'text-bottom',
                    animation: 'pulse 1s infinite',
                  }}
                />
              </div>
            </div>
          )}

          {/* Phase indicator */}
          {busy && !streaming && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px' }}>
              <Dots />
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                {phase === 'retrieving' ? 'Searching codebase...' : 'Thinking...'}
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              style={{
                margin: '4px 2px',
                padding: '8px 12px',
                borderRadius: 10,
                fontSize: 11,
                color: 'var(--destructive)',
                background: 'rgba(255,59,48,0.06)',
                border: '0.5px solid rgba(255,59,48,0.15)',
              }}
            >
              {error}
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Input bar + slash popup */}
        <div style={{ padding: '8px 2px 4px', flexShrink: 0, position: 'relative' }}>
          {/* Slash command popup */}
          {slashSuggestions.length > 0 && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 2,
                right: 2,
                marginBottom: 4,
                background: 'var(--bg-grouped)',
                border: '0.5px solid var(--border)',
                borderRadius: 10,
                boxShadow: 'var(--shadow-grouped)',
                overflow: 'hidden',
                zIndex: 50,
              }}
            >
              {slashSuggestions.map((cmd, i) => (
                <button
                  type="button"
                  key={cmd.name}
                  onClick={() => {
                    setInput(`/${cmd.name}${cmd.needsArgs ? ' ' : ''}`);
                    setSlashSuggestions([]);
                    taRef.current?.focus();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '7px 12px',
                    background: i === slashIndex ? 'var(--accent-tint, rgba(0,122,255,0.08))' : 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderBottom: i < slashSuggestions.length - 1 ? '0.5px solid var(--border)' : 'none',
                  }}
                >
                  <code
                    style={{
                      fontSize: 11,
                      color: 'var(--accent)',
                      fontFamily: 'monospace',
                      minWidth: 80,
                    }}
                  >
                    /{cmd.name}
                  </code>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {cmd.description}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--text-tertiary)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                    {cmd.usage}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 12,
              background: 'var(--fill-control)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '0.5px solid var(--border)',
              boxShadow: 'var(--shadow-control)',
            }}
          >
            <textarea
              ref={taRef}
              value={input}
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
              placeholder="Ask about your code... (⌘↵ to send, / for commands)"
              rows={1}
              disabled={!ok}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                resize: 'none',
                fontSize: 12,
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                minHeight: 20,
                maxHeight: 140,
                lineHeight: '1.5',
              }}
            />
            {busy ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                title="Stop"
                style={{
                  ...btnBase,
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: 'rgba(255,59,48,0.1)',
                  color: 'var(--destructive)',
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect width="10" height="10" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!input.trim() || !ok}
                title="Send (⌘↵)"
                style={{
                  ...btnBase,
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: input.trim() && ok ? 'var(--accent)' : 'transparent',
                  color: input.trim() && ok ? '#fff' : 'var(--text-tertiary)',
                  cursor: input.trim() && ok ? 'pointer' : 'default',
                  transition: 'all 0.15s',
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Transparency panel (280px, collapsible) ──────────────── */}
      <TransparencyPanel
        envelope={lastAssistantEnvelope}
        open={panelOpen}
        onToggle={() => setPanelOpen((v) => !v)}
      />
    </div>
  );
}

// ── Markdown renderer with copy-to-clipboard code blocks ─────────────

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const code = typeof children === 'string' ? children : String(children ?? '');

  const copy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [code]);

  return (
    <div style={{ position: 'relative' }} className="group">
      <pre
        style={{
          background: 'var(--bg-code, rgba(0,0,0,0.06))',
          borderRadius: 7,
          padding: '8px 10px',
          overflowX: 'auto',
          fontSize: 11,
          lineHeight: '1.5',
          margin: '6px 0',
          border: '0.5px solid var(--border)',
        }}
      >
        <code className={className} style={{ fontFamily: 'monospace' }}>
          {code}
        </code>
      </pre>
      <button
        type="button"
        onClick={copy}
        title="Copy code"
        style={{
          position: 'absolute',
          top: 5,
          right: 6,
          fontSize: 9,
          padding: '2px 7px',
          borderRadius: 5,
          background: copied ? 'var(--success, #34c759)' : 'var(--fill-control)',
          border: '0.5px solid var(--border)',
          color: copied ? '#fff' : 'var(--text-secondary)',
          cursor: 'pointer',
          transition: 'all 0.15s',
          opacity: 0.85,
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: 'monospace',
        fontSize: '0.9em',
        background: 'var(--bg-code, rgba(0,0,0,0.06))',
        borderRadius: 4,
        padding: '1px 4px',
        border: '0.5px solid var(--border)',
      }}
    >
      {children}
    </code>
  );
}

function MarkdownBody({ content }: { content: string }) {
  return (
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
        // biome-ignore lint/suspicious/noExplicitAny: react-markdown passes untyped props
        code({ className, children, ...props }: any) {
          // Only reached for inline code (block code is intercepted by `pre` above).
          return <InlineCode {...props}>{children}</InlineCode>;
        },
        p({ children }) {
          return <p style={{ margin: '4px 0', lineHeight: '1.55' }}>{children}</p>;
        },
        ul({ children }) {
          return <ul style={{ paddingLeft: 16, margin: '4px 0' }}>{children}</ul>;
        },
        ol({ children }) {
          return <ol style={{ paddingLeft: 16, margin: '4px 0' }}>{children}</ol>;
        },
        li({ children }) {
          return <li style={{ marginBottom: 2 }}>{children}</li>;
        },
        h1({ children }) {
          return <h1 style={{ fontSize: 14, fontWeight: 700, margin: '8px 0 4px' }}>{children}</h1>;
        },
        h2({ children }) {
          return <h2 style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 3px' }}>{children}</h2>;
        },
        h3({ children }) {
          return <h3 style={{ fontSize: 12, fontWeight: 600, margin: '4px 0 2px' }}>{children}</h3>;
        },
        table({ children }) {
          return (
            <div style={{ overflowX: 'auto', margin: '6px 0' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>{children}</table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th
              style={{
                padding: '4px 8px',
                borderBottom: '1px solid var(--border)',
                textAlign: 'left',
                fontWeight: 600,
                fontSize: 10,
                color: 'var(--text-secondary)',
              }}
            >
              {children}
            </th>
          );
        },
        td({ children }) {
          return (
            <td
              style={{
                padding: '3px 8px',
                borderBottom: '0.5px solid var(--border)',
                fontSize: 10,
              }}
            >
              {children}
            </td>
          );
        },
        blockquote({ children }) {
          return (
            <blockquote
              style={{
                borderLeft: '3px solid var(--accent)',
                paddingLeft: 10,
                margin: '4px 0',
                color: 'var(--text-secondary)',
                fontStyle: 'italic',
              }}
            >
              {children}
            </blockquote>
          );
        },
        strong({ children }) {
          return <strong style={{ fontWeight: 600 }}>{children}</strong>;
        },
        em({ children }) {
          return <em style={{ fontStyle: 'italic' }}>{children}</em>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── Transparency panel ────────────────────────────────────────────────

function TransparencyPanel({
  envelope,
  open,
  onToggle,
}: {
  envelope: ContextEnvelope | null;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        width: open ? 280 : 32,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '0.5px solid var(--border)',
        background: 'var(--bg-grouped)',
        transition: 'width 0.2s ease',
        overflow: 'hidden',
      }}
    >
      {/* Toggle button */}
      <button
        type="button"
        onClick={onToggle}
        title={open ? 'Hide context panel' : 'Show context panel'}
        style={{
          ...btnBase,
          flexShrink: 0,
          width: '100%',
          height: 36,
          borderBottom: '0.5px solid var(--border)',
          color: 'var(--text-tertiary)',
          background: 'none',
          cursor: 'pointer',
          justifyContent: open ? 'flex-end' : 'center',
          paddingRight: open ? 10 : 0,
          gap: 6,
        }}
      >
        {open && (
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
            Context
          </span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}
        >
          <polyline points="8 2 4 6 8 10" />
        </svg>
      </button>

      {/* Panel content */}
      {open && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
          {!envelope && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-tertiary)',
                textAlign: 'center',
                padding: '24px 0',
                lineHeight: 1.6,
              }}
            >
              Context used by the LLM appears here after you send a message.
              <br />
              <span style={{ fontSize: 9, opacity: 0.7 }}>
                Slash commands do not retrieve context.
              </span>
            </div>
          )}

          {envelope && (
            <>
              {/* Files — clickable, opens in editor */}
              <EnvelopeSection
                title="Files in context"
                count={envelope.files.length}
                empty="No files"
              >
                {envelope.files.map((f) => (
                  <EnvelopeItem
                    key={f}
                    label={f.split('/').pop() ?? f}
                    detail={f}
                    onClick={() => {
                      window.electronAPI?.openInEditor?.(f);
                    }}
                  />
                ))}
              </EnvelopeSection>

              {/* Symbols — tooltip shows full symbol_id; console.log on click */}
              {envelope.symbols.length > 0 && (
                <EnvelopeSection
                  title="Symbols read"
                  count={envelope.symbols.length}
                >
                  {envelope.symbols.map((s) => (
                    <EnvelopeItem
                      key={s.symbol_id}
                      label={s.symbol_id.split(':').pop() ?? s.symbol_id}
                      detail={s.symbol_id}
                      onClick={() =>
                        console.log('[trace-mcp] navigate to symbol:', s.symbol_id, s.file, s.line)
                      }
                    />
                  ))}
                </EnvelopeSection>
              )}

              {/* Decisions */}
              {envelope.decisions.length > 0 && (
                <EnvelopeSection
                  title="Decisions consulted"
                  count={envelope.decisions.length}
                >
                  {envelope.decisions.map((d) => (
                    <EnvelopeItem
                      key={d.id}
                      label={d.title}
                      onClick={() => console.log('[trace-mcp] navigate to decision:', d.id)}
                    />
                  ))}
                </EnvelopeSection>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EnvelopeSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {title}
        </span>
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-tertiary)',
            background: 'var(--fill-control)',
            borderRadius: 4,
            padding: '1px 5px',
          }}
        >
          {count}
        </span>
      </div>
      {count === 0 && empty && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{empty}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  );
}

function EnvelopeItem({
  label,
  detail,
  onClick,
}: {
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={detail ?? label}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        width: '100%',
        padding: '4px 6px',
        borderRadius: 6,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--fill-control)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'none';
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          width: '100%',
        }}
      >
        {label}
      </span>
      {detail && (
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%',
          }}
        >
          {detail}
        </span>
      )}
    </button>
  );
}

// ── Session sidebar item ───────────────────────────────────────────────

function SessionItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderRadius: 8,
        cursor: 'pointer',
        background: active
          ? 'var(--accent-tint, rgba(0,122,255,0.12))'
          : hovered
            ? 'var(--fill-control)'
            : 'transparent',
        marginBottom: 1,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: active ? 600 : 400,
            color: active ? 'var(--accent)' : 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {session.title || 'Untitled'}
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-tertiary)', marginTop: 1 }}>
          {session.msg_count} msg{session.msg_count !== 1 ? 's' : ''} ·{' '}
          {formatRelativeTime(session.last_msg_at)}
        </div>
      </div>
      {hovered && (
        <button
          type="button"
          onClick={onDelete}
          title="Delete chat"
          style={{
            ...btnBase,
            width: 18,
            height: 18,
            borderRadius: 4,
            background: 'none',
            color: 'var(--text-tertiary)',
            flexShrink: 0,
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const btnBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  padding: 0,
  flexShrink: 0,
};

const assistantStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 12,
  lineHeight: '1.55',
  color: 'var(--text-primary)',
  background: 'var(--bg-grouped)',
  boxShadow: 'var(--shadow-grouped)',
  borderRadius: '14px 14px 14px 4px',
};

// ── Sub-components ───────────────────────────────────────────────────

function Bubble({ msg }: { msg: ChatMessage }) {
  const u = msg.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: u ? 'flex-end' : 'flex-start',
        padding: '3px 2px',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          fontSize: 12,
          lineHeight: '1.55',
          maxWidth: '88%',
          ...(u
            ? {
                background: 'var(--accent)',
                color: '#fff',
                borderRadius: '14px 14px 4px 14px',
                whiteSpace: 'pre-wrap',
              }
            : assistantStyle),
        }}
      >
        {u ? msg.content : <MarkdownBody content={msg.content} />}
      </div>
    </div>
  );
}

function Dots() {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'var(--accent)',
            animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
