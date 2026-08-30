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
  /** ARIA role for the layer itself, e.g. "menu" for a context menu. */
  role?: string;
  children: React.ReactNode;
  /** Root-element ref (React 19 ref-as-prop). Menu needs it to hit-test
      document-level mousedown against the floating layer for outside-press
      dismissal — the layer still keeps its own internal ref for clamping. */
  ref?: React.Ref<HTMLDivElement>;
  /**
   * Element the layer must stay horizontally inside. Without it the layer
   * clamps to the window, so a wide popover opened from a content pane slides
   * left over the sidebar — navigation chrome a content overlay must never
   * cross (TRA-524). The element is also observed for resize, so the layer
   * re-clamps live while the sidebar divider is dragged.
   */
  boundsRef?: React.RefObject<HTMLElement | null>;
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
  role,
  children,
  ref: forwardedRef,
  boundsRef,
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
      const b = boundsRef?.current?.getBoundingClientRect();
      // Cap the layer to the pane before measuring, so a panel whose natural
      // width exceeds the pane shrinks instead of spilling out of it.
      el.style.maxWidth = b ? `${Math.max(0, b.width - m * 2)}px` : '';
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal — honor the requested anchoring, then pull fully inside the
      // bounding element when one is given, otherwise inside the window.
      const minX = b ? Math.max(m, b.left + m) : m;
      const maxX = b ? Math.min(vw - m, b.right - m) : vw - m;
      let left = align === 'end' ? x - w : x;
      if (left + w > maxX) left = maxX - w;
      if (left < minX) left = minX;

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
    // Dragging the sidebar divider resizes the pane without resizing the
    // window, so the bounds element needs its own observer.
    const bounds = boundsRef?.current;
    const ro = bounds ? new ResizeObserver(onResize) : null;
    if (bounds && ro) ro.observe(bounds);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [x, y, align, boundsRef]);

  return (
    <div ref={ref} role={role} className={className} style={{ ...style, left: pos.left, top: pos.top }}>
      {children}
    </div>
  );
}
