import { useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import { placeTooltip } from './graph-exploration';

/** Kept within the graph's stacking context, above all canvas overlays. */
export function GraphHover({
  anchor,
  boundsRef,
  children,
}: {
  anchor: { x: number; y: number };
  boundsRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = boundsRef.current;
    if (!el || !pane) return;
    const update = () => {
      const b = pane.getBoundingClientRect();
      el.style.maxWidth = `${Math.max(0, b.width - 16)}px`;
      el.style.maxHeight = `${Math.max(0, b.height - 16)}px`;
      const obstacles = [
        ...pane.querySelectorAll('.cosmos-gpu-legend, .cosmos-gpu-stats, .graph-inspector'),
      ].map((e) => e.getBoundingClientRect());
      const p = placeTooltip(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        b,
        obstacles,
      );
      setPos({ left: p.left - b.left, top: p.top - b.top });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor, boundsRef]);
  return (
    <div ref={ref} role="tooltip" className="graph-hover t-caption" style={pos}>
      {children}
    </div>
  );
}
