// @vitest-environment jsdom
/* TRA-504. When a filename alone fills the row width, the location (.dir)
   shrinks to a one-glyph sliver (e.g. `t`, `c`, `⌐`) under flexbox shrink.
   The layout effect detects `nameEl.scrollWidth > nameEl.clientWidth` and toggles
   `is-name-clipped` on `.ws-sb-path` so `.dir` hides completely. */

import { render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  updateSidebarPathClipping,
  useSidebarPathClipping,
} from '../useSidebarPathClipping';

function createRow({
  name,
  dir,
  nameScrollWidth,
  nameClientWidth,
}: {
  name: string;
  dir?: string;
  nameScrollWidth: number;
  nameClientWidth: number;
}): HTMLElement {
  const path = document.createElement('span');
  path.className = 'ws-sb-path';

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = name;
  Object.defineProperty(nameEl, 'scrollWidth', {
    configurable: true,
    get: () => nameScrollWidth,
  });
  Object.defineProperty(nameEl, 'clientWidth', {
    configurable: true,
    get: () => nameClientWidth,
  });
  path.appendChild(nameEl);

  if (dir) {
    const dirEl = document.createElement('span');
    dirEl.className = 'dir';
    dirEl.textContent = dir;
    path.appendChild(dirEl);
  }

  return path;
}

describe('updateSidebarPathClipping', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('leaves is-name-clipped off when the filename fits within client width', () => {
    const row = createRow({
      name: 'Settings.tsx',
      dir: 'tabs',
      nameScrollWidth: 80,
      nameClientWidth: 80,
    });
    container.appendChild(row);

    updateSidebarPathClipping(container);

    expect(row.classList.contains('is-name-clipped')).toBe(false);
  });

  it('adds is-name-clipped when the filename overflows client width', () => {
    const row = createRow({
      name: 'ProjectStatsModal.tsx',
      dir: 'components',
      nameScrollWidth: 140,
      nameClientWidth: 110,
    });
    container.appendChild(row);

    updateSidebarPathClipping(container);

    expect(row.classList.contains('is-name-clipped')).toBe(true);
  });

  it('removes is-name-clipped when container widens so filename is no longer clipped', () => {
    let nameClientWidth = 110;
    const path = document.createElement('span');
    path.className = 'ws-sb-path is-name-clipped';

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = 'ProjectStatsModal.tsx';
    Object.defineProperty(nameEl, 'scrollWidth', {
      configurable: true,
      get: () => 140,
    });
    Object.defineProperty(nameEl, 'clientWidth', {
      configurable: true,
      get: () => nameClientWidth,
    });
    path.appendChild(nameEl);

    const dirEl = document.createElement('span');
    dirEl.className = 'dir';
    dirEl.textContent = 'components';
    path.appendChild(dirEl);

    container.appendChild(path);

    // Initial check while narrow: remains clipped
    updateSidebarPathClipping(container);
    expect(path.classList.contains('is-name-clipped')).toBe(true);

    // Container widened
    nameClientWidth = 160;
    updateSidebarPathClipping(container);
    expect(path.classList.contains('is-name-clipped')).toBe(false);
  });

  it('does not add is-name-clipped when there is no directory element', () => {
    const row = createRow({
      name: 'README.md',
      nameScrollWidth: 150,
      nameClientWidth: 100,
    });
    container.appendChild(row);

    updateSidebarPathClipping(container);

    expect(row.classList.contains('is-name-clipped')).toBe(false);
  });

  it('handles container being the ws-sb-path element directly', () => {
    const row = createRow({
      name: 'GraphExplorerGPU.tsx',
      dir: 'tabs',
      nameScrollWidth: 150,
      nameClientWidth: 100,
    });

    updateSidebarPathClipping(row);

    expect(row.classList.contains('is-name-clipped')).toBe(true);
  });

  it('handles null or empty container gracefully', () => {
    expect(() => updateSidebarPathClipping(null)).not.toThrow();
    expect(() => updateSidebarPathClipping(container)).not.toThrow();
  });
});

describe('useSidebarPathClipping hook', () => {
  it('updates clipping on render and when deps change', () => {
    function TestComponent({
      files,
      width,
    }: {
      files: { name: string; dir?: string; scrollW: number; clientW: number }[];
      width: number;
    }) {
      const ref = useSidebarPathClipping<HTMLDivElement>([files, width]);
      return (
        <div ref={ref}>
          {files.map((f) => (
            <span key={f.name} className="ws-sb-path" data-testid={`path-${f.name}`}>
              <span
                className="name"
                ref={(el) => {
                  if (el) {
                    Object.defineProperty(el, 'scrollWidth', {
                      configurable: true,
                      get: () => f.scrollW,
                    });
                    Object.defineProperty(el, 'clientWidth', {
                      configurable: true,
                      get: () => f.clientW,
                    });
                  }
                }}
              >
                {f.name}
              </span>
              {f.dir && <span className="dir">{f.dir}</span>}
            </span>
          ))}
        </div>
      );
    }

    const { rerender, getByTestId } = render(
      <TestComponent
        width={220}
        files={[
          { name: 'Settings.tsx', dir: 'tabs', scrollW: 80, clientW: 80 },
          { name: 'GraphExplorerGPU.tsx', dir: 'tabs', scrollW: 150, clientW: 100 },
        ]}
      />,
    );

    expect(getByTestId('path-Settings.tsx').classList.contains('is-name-clipped')).toBe(false);
    expect(getByTestId('path-GraphExplorerGPU.tsx').classList.contains('is-name-clipped')).toBe(true);

    // Rerender with wider width
    rerender(
      <TestComponent
        width={320}
        files={[
          { name: 'Settings.tsx', dir: 'tabs', scrollW: 80, clientW: 80 },
          { name: 'GraphExplorerGPU.tsx', dir: 'tabs', scrollW: 150, clientW: 160 },
        ]}
      />,
    );

    expect(getByTestId('path-GraphExplorerGPU.tsx').classList.contains('is-name-clipped')).toBe(false);
  });
});
