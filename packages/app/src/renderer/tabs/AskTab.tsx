import { useState, useRef, useEffect, useCallback } from 'react';

const BASE = 'http://127.0.0.1:3741';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

type Phase = 'idle' | 'retrieving' | 'streaming' | 'error';

function storageKey(root: string): string {
  return `trace-mcp:ask:${root}`;
}

function loadHistory(root: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-50) : [];
  } catch {
    return [];
  }
}

function saveHistory(root: string, messages: ChatMessage[]): void {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(messages.slice(-50)));
  } catch { /* quota exceeded — ignore */ }
}

export function AskTab({ root }: { root: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory(root));
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [providerName, setProviderName] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Persist history
  useEffect(() => {
    saveHistory(root, messages);
  }, [root, messages]);

  // Detect provider on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/ask/provider?project=${encodeURIComponent(root)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.provider) {
          setProviderName(data.provider);
          setProviderError(null);
        } else if (data.error) {
          setProviderName(null);
          setProviderError(data.error);
        }
      } catch {
        if (!cancelled) setProviderError('Cannot reach daemon');
      }
    })();
    return () => { cancelled = true; };
  }, [root]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Abort on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if (!question || phase === 'retrieving' || phase === 'streaming') return;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: question };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setError(null);
    setPhase('retrieving');
    setStreamingContent('');

    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${BASE}/api/ask?project=${encodeURIComponent(root)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: updatedMessages.map(m => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(errBody || `HTTP ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          try {
            const event = JSON.parse(trimmed.slice(6)) as {
              type: string;
              phase?: string;
              content?: string;
              message?: string;
            };

            if (event.type === 'phase') {
              if (event.phase === 'streaming') setPhase('streaming');
            } else if (event.type === 'chunk' && event.content) {
              accumulated += event.content;
              setStreamingContent(accumulated);
              if (phase !== 'streaming') setPhase('streaming');
            } else if (event.type === 'done') {
              const assistantMsg: ChatMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: accumulated,
              };
              setMessages(prev => [...prev, assistantMsg]);
              setStreamingContent('');
              setPhase('idle');
            } else if (event.type === 'error') {
              throw new Error(event.message ?? 'Unknown error');
            }
          } catch (parseErr) {
            if ((parseErr as Error).message && !(parseErr as Error).message.includes('JSON')) {
              throw parseErr;
            }
          }
        }
      }

      // If stream ended without a 'done' event, finalize
      if (accumulated && phase !== 'idle') {
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: accumulated,
        };
        setMessages(prev => [...prev, assistantMsg]);
        setStreamingContent('');
        setPhase('idle');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setError(e?.message ?? 'Unknown error');
      setPhase('error');
      setStreamingContent('');
    } finally {
      abortRef.current = null;
    }
  }, [input, messages, phase, root]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleClear = useCallback(() => {
    setMessages([]);
    setStreamingContent('');
    setError(null);
    setPhase('idle');
    localStorage.removeItem(storageKey(root));
  }, [root]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleTextareaInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  const isLoading = phase === 'retrieving' || phase === 'streaming';

  return (
    <div className="flex flex-col h-full" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {/* Header */}
      <div className="flex items-center gap-2 pb-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Ask</h2>
        {providerName && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            {providerName}
          </span>
        )}
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="ml-auto text-[10px] px-1.5 py-0.5 rounded transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            title="Clear conversation"
          >
            Clear
          </button>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pb-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Empty state */}
        {messages.length === 0 && !isLoading && !error && (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-8">
            <div className="text-[11px] text-center" style={{ color: 'var(--text-tertiary)' }}>
              Ask a question about your codebase
            </div>
            <div className="text-[10px] text-center" style={{ color: 'var(--text-tertiary)', opacity: 0.7 }}>
              Context is retrieved from the project's dependency graph for accurate answers
            </div>
            {providerError && (
              <div
                className="text-[10px] text-center mt-2 px-3 py-2 rounded-lg max-w-sm"
                style={{ background: 'rgba(255,59,48,0.08)', color: 'var(--destructive)' }}
              >
                {providerError}
              </div>
            )}
          </div>
        )}

        {/* Message bubbles */}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming message */}
        {streamingContent && (
          <div className="flex justify-start">
            <div
              className="px-3 py-2 rounded-lg text-xs max-w-[85%] whitespace-pre-wrap"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
            >
              {streamingContent}
              <span className="animate-pulse ml-0.5">|</span>
            </div>
          </div>
        )}

        {/* Phase indicator */}
        {phase === 'retrieving' && (
          <div className="flex justify-start">
            <div className="text-[10px] px-3 py-1.5" style={{ color: 'var(--text-tertiary)' }}>
              Retrieving context...
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            className="px-3 py-2 rounded-lg text-[11px]"
            style={{ background: 'rgba(255,59,48,0.08)', color: 'var(--destructive)' }}
          >
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="pt-2" style={{ borderTop: '1px solid var(--border-row)' }}>
        <div
          className="flex items-end gap-1.5 rounded-lg px-2.5 py-1.5"
          style={{ background: 'var(--bg-secondary)', border: '0.5px solid var(--border)' }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); handleTextareaInput(); }}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your code..."
            rows={1}
            disabled={providerError !== null && providerName === null}
            className="flex-1 bg-transparent text-xs resize-none outline-none placeholder-opacity-50"
            style={{
              color: 'var(--text-primary)',
              minHeight: 20,
              maxHeight: 120,
              lineHeight: '1.5',
            }}
          />
          {isLoading ? (
            <button
              onClick={handleStop}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-colors"
              style={{ color: 'var(--destructive)' }}
              title="Stop"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <rect width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || (providerError !== null && providerName === null)}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-colors"
              style={{
                color: input.trim() ? 'var(--accent)' : 'var(--text-tertiary)',
                opacity: input.trim() ? 1 : 0.5,
              }}
              title="Send (Enter)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22L11 13L2 9L22 2Z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className="px-3 py-2 rounded-lg text-xs max-w-[85%] whitespace-pre-wrap"
        style={isUser ? {
          background: 'var(--accent)',
          color: '#fff',
        } : {
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
        }}
      >
        {message.content}
      </div>
    </div>
  );
}
