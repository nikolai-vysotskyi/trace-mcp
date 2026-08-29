// @vitest-environment jsdom
//
// Appearance moved out of the sidebar footer and into the Settings screen
// (TRA-306). The footer no longer offers it, so this is now the only surface
// that does — and it has to keep offering all three states even when the
// daemon is unreachable, because the theme lives in localStorage and has
// nothing to do with the daemon.
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../Settings';

beforeEach(() => {
  const makeApiProxy = (name = ''): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, prop) => makeApiProxy(typeof prop === 'string' ? prop : ''),
      apply: () => (name.startsWith('on') ? () => undefined : Promise.resolve(undefined)),
    });
  (window as unknown as { electronAPI: unknown }).electronAPI = makeApiProxy();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('daemon down'))),
  );
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
    },
  );
});

describe('Settings — Appearance', () => {
  it('offers Auto / Light / Dark even with no daemon', () => {
    render(<Settings appearance="auto" onAppearanceChange={() => {}} />);
    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Auto', 'Light', 'Dark']);
    expect(select.value).toBe('auto');
  });

  it('reports the picked appearance upwards', () => {
    const onChange = vi.fn();
    render(<Settings appearance="auto" onAppearanceChange={onChange} />);
    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });
});
