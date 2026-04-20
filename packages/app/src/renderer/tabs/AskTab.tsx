import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

const BASE = 'http://127.0.0.1:3741';

// ── Types ────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

type Phase = 'idle' | 'retrieving' | 'streaming' | 'error';

// ── Persistence ──────────────────────────────────────────────────────

const sKey = (root: string) => `trace-mcp:ask:${root}`;

function loadHistory(root: string): ChatMessage[] {
  try {
    const r = localStorage.getItem(sKey(root));
    return r ? (JSON.parse(r) as ChatMessage[]).slice(-50) : [];
  } catch { return []; }
}

function saveHistory(root: string, m: ChatMessage[]) {
  try { localStorage.setItem(sKey(root), JSON.stringify(m.slice(-50))); } catch {}
}

// ── Component ────────────────────────────────────────────────────────

export function AskTab({ root }: { root: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory(root));
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [streaming, setStreaming] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [providerReady, setProviderReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { saveHistory(root, messages); }, [root, messages]);

  // Provider detection
  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/ask/provider?project=${encodeURIComponent(root)}`);
        if (c || !r.ok) return;
        const d = await r.json();
        if (!c) { setProvider(d.provider ?? null); setProviderReady(true); }
      } catch { if (!c) setProviderReady(true); }
    })();
    return () => { c = true; };
  }, [root]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const ok = provider !== null;
  const busy = phase === 'retrieving' || phase === 'streaming';

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy || !ok) return;

    const msg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: q, ts: Date.now() };
    const all = [...messages, msg];
    setMessages(all); setInput(''); setError(null); setPhase('retrieving'); setStreaming('');
    if (taRef.current) taRef.current.style.height = 'auto';

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch(`${BASE}/api/ask?project=${encodeURIComponent(root)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: all.map(m => ({ role: m.role, content: m.content })) }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`));

      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '', acc = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop()!;
        for (const ln of lines) {
          const t = ln.trim();
          if (!t || !t.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(t.slice(6));
            if (ev.type === 'phase' && ev.phase === 'streaming') setPhase('streaming');
            else if (ev.type === 'chunk' && ev.content) { acc += ev.content; setStreaming(acc); setPhase('streaming'); }
            else if (ev.type === 'done') {
              const finalContent = acc;
              acc = '';
              setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: finalContent, ts: Date.now() }]);
              setStreaming(''); setPhase('idle');
            } else if (ev.type === 'error') throw new Error(ev.message);
          } catch (e) { if ((e as Error).message && !(e as Error).message.includes('JSON')) throw e; }
        }
      }
      if (acc) {
        const finalContent = acc;
        acc = '';
        setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: finalContent, ts: Date.now() }]);
        setStreaming(''); setPhase('idle');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') { setPhase('idle'); return; }
      setError(e?.message ?? 'Unknown error'); setPhase('error'); setStreaming('');
    } finally { abortRef.current = null; }
  }, [input, messages, busy, ok, root]);

  const grow = useCallback(() => {
    const el = taRef.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, []);

  const openSettings = useCallback(() => {
    (window as any).electronAPI?.openSettings?.('ai');
  }, []);

  // ── No provider → setup CTA ─────────────────────────────────────
  if (providerReady && !ok) {
    return (
      <div className="flex flex-col items-center justify-center h-full" style={{ WebkitAppRegion: 'no-drag', gap: 20 } as React.CSSProperties}>
        {/* Icon */}
        <div style={{
          width: 56, height: 56, borderRadius: 16,
          background: 'var(--fill-control)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: '0.5px solid var(--border)',
          boxShadow: 'var(--shadow-grouped)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>

        {/* Text */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>
            Connect an AI provider
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, lineHeight: '1.5' }}>
            Required for Ask to work
          </div>
        </div>

        {/* CTA Button */}
        <button
          onClick={openSettings}
          type="button"
          style={{
            fontSize: 13, fontWeight: 500,
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

  // ── Chat ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '0 2px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Empty state */}
        {messages.length === 0 && !busy && (
          <div className="flex flex-col items-center justify-center h-full" style={{ gap: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', maxWidth: 240 }}>
              Ask anything about this codebase
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6, maxWidth: 340 }}>
              {['How does auth work?', 'Explain the plugin system', 'Where are API routes?'].map(q => (
                <button
                  key={q}
                  onClick={() => { setInput(q); taRef.current?.focus(); }}
                  style={{
                    fontSize: 10, padding: '5px 10px', borderRadius: 8,
                    background: 'var(--fill-control)',
                    backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                    border: '0.5px solid var(--border)',
                    boxShadow: 'var(--shadow-control)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Bubbles */}
        {messages.map(m => <Bubble key={m.id} msg={m} />)}

        {/* Streaming */}
        {streaming && (
          <div style={{ display: 'flex', padding: '3px 2px' }}>
            <div style={{
              ...assistantStyle,
              maxWidth: '88%',
            }}>
              {streaming}
              <span style={{ display: 'inline-block', width: 6, height: 14, marginLeft: 2, borderRadius: 2, background: 'var(--accent)', verticalAlign: 'text-bottom', animation: 'pulse 1s infinite' }} />
            </div>
          </div>
        )}

        {/* Retrieving / waiting for first chunk */}
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
          <div style={{
            margin: '4px 2px', padding: '8px 12px', borderRadius: 10,
            fontSize: 11, color: 'var(--destructive)',
            background: 'rgba(255,59,48,0.06)',
            border: '0.5px solid rgba(255,59,48,0.15)',
          }}>
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input bar */}
      <div style={{ padding: '8px 2px 4px' }}>
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 6,
          padding: '8px 12px',
          borderRadius: 12,
          background: 'var(--fill-control)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: '0.5px solid var(--border)',
          boxShadow: 'var(--shadow-control)',
        }}>
          <textarea
            ref={taRef}
            value={input}
            onChange={e => { setInput(e.target.value); grow(); }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask about your code..."
            rows={1}
            disabled={!ok}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              fontSize: 12, color: 'var(--text-primary)', fontFamily: 'inherit',
              minHeight: 20, maxHeight: 140, lineHeight: '1.5',
            }}
          />
          {busy ? (
            <button onClick={() => abortRef.current?.abort()} title="Stop" style={{
              ...btnBase, width: 28, height: 28, borderRadius: 8,
              background: 'rgba(255,59,48,0.1)', color: 'var(--destructive)',
            }}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="2" /></svg>
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim() || !ok} title="Send" style={{
              ...btnBase, width: 28, height: 28, borderRadius: 8,
              background: input.trim() && ok ? 'var(--accent)' : 'transparent',
              color: input.trim() && ok ? '#fff' : 'var(--text-tertiary)',
              cursor: input.trim() && ok ? 'pointer' : 'default',
              transition: 'all 0.15s',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Status line */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: ok ? 'var(--success)' : 'var(--text-tertiary)' }} />
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
              {!providerReady ? 'Connecting...' : provider ?? 'No provider'}
            </span>
          </div>
          {messages.length > 0 && (
            <button onClick={() => { setMessages([]); setStreaming(''); setError(null); setPhase('idle'); localStorage.removeItem(sKey(root)); }}
              style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer' }}>
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const btnBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', padding: 0, flexShrink: 0,
};

const assistantStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 12, lineHeight: '1.55', whiteSpace: 'pre-wrap',
  color: 'var(--text-primary)',
  background: 'var(--bg-grouped)',
  boxShadow: 'var(--shadow-grouped)',
  borderRadius: '14px 14px 14px 4px',
};

// ── Sub-components ───────────────────────────────────────────────────

function Bubble({ msg }: { msg: ChatMessage }) {
  const u = msg.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: u ? 'flex-end' : 'flex-start', padding: '3px 2px' }}>
      <div style={{
        padding: '10px 14px',
        fontSize: 12, lineHeight: '1.55', whiteSpace: 'pre-wrap',
        maxWidth: '88%',
        ...(u ? {
          background: 'var(--accent)', color: '#fff',
          borderRadius: '14px 14px 4px 14px',
        } : assistantStyle),
      }}>
        {msg.content}
      </div>
    </div>
  );
}

function Dots() {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)',
          animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
    </div>
  );
}
