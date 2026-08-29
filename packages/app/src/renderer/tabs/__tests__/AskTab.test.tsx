/**
 * @vitest-environment jsdom
 *
 * TRA-312. These assert what the Ask migration exists to fix, so the surface
 * fails loudly if it drifts back:
 *
 *   - a toolbar, where the surface previously drew no chrome at all
 *   - four real states: empty, loading, error (with the question preserved)
 *     and populated — the old error was a red strip with no way forward
 *   - the delete affordance has a keyboard route, not hover only
 *   - the context inspector is closed until the user asks for it
 *   - no ALL-CAPS, no type below 11px, no glass on content, no `--accent`
 *     used as a background
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskTab } from '../AskTab';

const ROOT = '/tmp/proj';
const now = Date.now();

const SESSIONS = [
  { id: 's1', project_root: ROOT, title: 'Where does the indexer resolve imports?', created_at: now, last_msg_at: now - 120_000, msg_count: 6 },
  { id: 's2', project_root: ROOT, title: 'Explain the plugin registry', created_at: now, last_msg_at: now - 7_200_000, msg_count: 2 },
];

const ENVELOPE = {
  files: ['src/indexer/resolve.ts'],
  symbols: [{ symbol_id: 'src/indexer/resolve.ts:resolveEdges', file: 'src/indexer/resolve.ts', line: 12 }],
  decisions: [{ id: 'd1', title: 'Edges resolve in pass 2' }],
};

const MESSAGES = [
  { id: 'm1', role: 'user', content: 'Where does the indexer resolve imports?', created_at: now - 120_000 },
  { id: 'm2', role: 'assistant', content: 'In `resolveEdges()`, during pass 2.', created_at: now - 110_000, context_envelope: ENVELOPE },
];

/** Route every endpoint Ask touches. `opts.send` decides what a POST does. */
function mockApi(opts: { provider?: string | null; messages?: unknown[]; sendFails?: boolean } = {}) {
  const { provider = 'anthropic/claude-sonnet-5', messages = MESSAGES, sendFails = false } = opts;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const u = String(input);
      if (sendFails && u.endsWith('/messages')) {
        return Promise.resolve(new Response('The provider rejected the request.', { status: 502 }));
      }
      let body: unknown = {};
      if (u.includes('/api/ask/provider')) body = { provider };
      else if (/\/api\/ask\/sessions\/[^/?]+$/.test(u)) body = { messages };
      else if (u.includes('/api/ask/sessions')) body = { sessions: SESSIONS };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

beforeEach(() => {
  const api = new Proxy(function () {} as object, {
    get: () => () => Promise.resolve(undefined),
    apply: () => Promise.resolve(undefined),
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  localStorage.clear();
  /* jsdom has no layout, so scrollIntoView is not implemented. */
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AskTab root={ROOT} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return result;
}

describe('Ask chrome', () => {
  it('draws exactly one toolbar, where it used to draw none', async () => {
    mockApi();
    const { container } = await mount();
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  });

  it('names every icon-only control for the pointer and the screen reader', async () => {
    mockApi();
    const { container } = await mount();
    for (const button of Array.from(container.querySelectorAll('button'))) {
      if ((button.textContent ?? '').trim().length > 0) continue;
      expect(button.getAttribute('aria-label'), button.outerHTML).toBeTruthy();
      expect(button.getAttribute('title'), button.outerHTML).toBeTruthy();
    }
  });

  it('reports the provider as a word, not as a coloured dot alone', async () => {
    mockApi();
    await mount();
    screen.getByText('anthropic/claude-sonnet-5');
  });

  it('keeps the context inspector closed until it is asked for', async () => {
    mockApi();
    const { container } = await mount();
    expect(container.querySelector('.ask-inspector')).toBeNull();

    const toggle = screen.getByRole('button', { name: 'Show the context panel' });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(container.querySelector('.ask-inspector')).not.toBeNull();
    expect(localStorage.getItem('trace-mcp.ask.context-panel')).toBe('1');
  });
});

describe('Ask states', () => {
  it('offers a way forward when no provider is configured', async () => {
    mockApi({ provider: null });
    await mount();
    screen.getByText('Connect an AI provider');
    screen.getByRole('button', { name: 'Open AI settings' });
  });

  /* The setup CTA is the first thing a new install shows, so it is the one
     state that must not fall back to the pre-migration "no chrome at all". */
  it('keeps the toolbar in the no-provider state', async () => {
    mockApi({ provider: null });
    const { container } = await mount();
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    within(container.querySelector('[role="toolbar"]') as HTMLElement).getByText('Ask');
  });

  it('shows the slash-command reference and starter questions on an empty chat', async () => {
    mockApi({ messages: [] });
    await mount();
    screen.getByText('Ask anything about this codebase');
    screen.getByText('Slash commands');
    screen.getByText('/find <query>');
    screen.getByRole('button', { name: 'How does auth work?' });
  });

  it('renders the conversation once a session has messages', async () => {
    mockApi();
    localStorage.setItem(`trace-mcp:current-chat-session-${ROOT}`, 's1');
    await mount();
    const log = screen.getByRole('log', { name: 'Conversation' });
    within(log).getByText('Where does the indexer resolve imports?');
    expect(screen.queryByText('Ask anything about this codebase')).toBeNull();
  });

  it('keeps the failed question in the composer and offers to send it again', async () => {
    mockApi({ sendFails: true });
    localStorage.setItem(`trace-mcp:current-chat-session-${ROOT}`, 's1');
    await mount();

    const box = screen.getByRole('textbox', { name: 'Ask about this project' });
    await act(async () => {
      fireEvent.change(box, { target: { value: 'Why is vendor/ skipped?' } });
    });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    screen.getByRole('alert');
    screen.getByRole('button', { name: 'Send again' });
    /* The question is not lost: a failed send must not cost what was typed. */
    expect((box as HTMLTextAreaElement).value).toBe('Why is vendor/ skipped?');
  });
});

describe('Ask chat list', () => {
  it('gives the delete affordance a keyboard route rather than hover alone', async () => {
    mockApi();
    await mount();
    const row = screen.getByRole('button', { name: /Where does the indexer resolve imports/ });
    await act(async () => {
      fireEvent.keyDown(row, { key: 'Backspace' });
      await Promise.resolve();
    });
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(true);
  });
});

/* ── Source-level guards ───────────────────────────────────────────────────
   jsdom resolves no stylesheet, so the type-scale and material rules are
   checked where they are written — same shape as the TRA-294 guards. */
describe('type scale and material', () => {
  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  const tsx = () => read('src/renderer/tabs/AskTab.tsx');
  const css = () => read('src/renderer/styles/ask.css');

  it('has no type below 11px', () => {
    const src = `${tsx()}\n${css()}`;
    const sizes = [
      ...[...src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1])),
      ...[...src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])),
      ...[...src.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])),
    ];
    expect(sizes.filter((n) => n < 11)).toEqual([]);
  });

  it('ships no ALL-CAPS strings', () => {
    expect(`${tsx()}\n${css()}`).not.toMatch(/text-transform|textTransform|uppercase|toUpperCase\(\)/);
  });

  it('puts no glass on content — the toolbar is the only translucent layer', () => {
    expect(tsx()).not.toMatch(/backdropFilter|backdrop-filter/);
    expect(css()).not.toMatch(/backdrop-filter/);
  });

  it('fills the user bubble with --accent-fill, not --accent', () => {
    /* --accent is tuned to read AS text on --surface; white on it measures
       3.65:1 in dark. A fill that carries a label uses --accent-fill.
       DESIGN.md §2. (The 4px typing dots and the caret carry no label, so they
       keep --accent — that is the same thing StatusDot does with a tone.) */
    const bubble = /\.ask-msg\.is-user \.ask-bubble \{([^}]*)\}/.exec(css())?.[1] ?? '';
    expect(bubble).toMatch(/background:\s*var\(--accent-fill\)/);
    expect(bubble).toMatch(/color:\s*var\(--on-accent\)/);
  });

  it('uses no radius outside the scale', () => {
    const bad = [...css().matchAll(/border-radius:\s*(\d+)px/g)]
      .map((m) => Number(m[1]))
      .filter((n) => ![2, 6, 8, 10, 12].includes(n));
    expect(bad).toEqual([]);
  });
});
