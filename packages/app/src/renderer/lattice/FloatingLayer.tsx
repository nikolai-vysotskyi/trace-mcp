import React, { useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

/** Keep floating overlays this many px away from the window edges. */
const VIEWPORT_MARGIN = 8;

export interface FloatingLayerProps {
  /** Anchor point in viewport coordinates (cursor, or a button corner). */
  x: number;
  y: number;
  /** Horizontal anchoring: 'start' = left edge at x, 'end' = right edge at x. */
  align?: 'start' | 'end';
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  /** Root-element ref (React 19 ref-as-prop). Menu needs it to hit-test
      document-level mousedown against the floating layer for outside-press
      dismissal — the layer still keeps its own internal ref for clamping. */
  ref?: React.Ref<HTMLDivElement>;
}

/**
 * A `position: fixed` overlay (menu / popover) that keeps itself inside the
 * viewport. It opens from the anchor, pulls in when it would overflow the right
 * edge, and flips above the anchor when it would overflow the bottom. The
 * element is measured in a layout effect (before paint) so it adapts to any
 * menu size without hard-coded dimensions — and re-clamps if the window resizes
 * while it is open.
 */
export function FloatingLayer({
  x,
  y,
  align = 'start',
  className,
  style,
  children,
  ref: forwardedRef,
}: FloatingLayerProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // Expose the root element to callers without giving up our internal ref
  // (the clamp effect needs it on every render). The div's identity never
  // changes, so empty deps are correct.
  useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement, []);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: align === 'end' ? x : x,
    top: y,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const clamp = (): void => {
      const m = VIEWPORT_MARGIN;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal — honor the requested anchoring, then pull fully in-window.
      let left = align === 'end' ? x - w : x;
      if (left + w + m > vw) left = vw - w - m;
      if (left < m) left = m;

      // Vertical — flip above the anchor when it would overflow the bottom.
      let top = y;
      if (top + h + m > vh) top = y - h;
      if (top < m) top = m;
      if (top + h + m > vh) top = vh - h - m;

      setPos({ left, top });
    };

    clamp();
    // ponytail: coalesce resize bursts into one rAF — clamp() reads layout then
    // setState, so running it per raw event thrashed layout while dragging the window.
    let raf = 0;
    const onResize = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        clamp();
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [x, y, align]);

  return (
    <div ref={ref} className={className} style={{ ...style, left: pos.left, top: pos.top }}>
      {children}
    </div>
  );
}
