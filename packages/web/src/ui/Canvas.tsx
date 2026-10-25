import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type Bounds = { x: number; y: number; width: number; height: number };
type Props = { width: number; height: number; children: ReactNode; fitKey: string; wheelZoom?: boolean; fitBounds?: Bounds };
type View = { scale: number; x: number; y: number };

const MAX_FIT = 1.15;
const LEGEND_ROOM = 56;

/** Pan/zoom surface for a diagram of a known size. Fits on load and whenever `fitKey` changes. */
export function Canvas({ width, height, children, fitKey, wheelZoom = false, fitBounds }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !width || !height) return;
    // Bottom margin leaves room for the legend.
    const bounds = fitBounds ?? { x: 0, y: 0, width, height };
    const scale = Math.max(0.05, Math.min(MAX_FIT, (el.clientWidth - 32) / bounds.width, (el.clientHeight - 16 - LEGEND_ROOM) / bounds.height));
    setView({ scale, x: (el.clientWidth - bounds.width * scale) / 2 - bounds.x * scale, y: Math.max(16, (el.clientHeight - LEGEND_ROOM - bounds.height * scale) / 2) - bounds.y * scale });
  }, [width, height, fitBounds]);

  useEffect(() => {
    fit();
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, fitKey]);

  const zoomAt = (factor: number, cx: number, cy: number): void =>
    setView((v) => {
      const scale = Math.min(3, Math.max(0.2, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!wheelZoom && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wheelZoom]);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || (e.target as Element).closest("button, [role=button]")) return;
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    const move = (ev: PointerEvent): void => setView((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y }));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const center = (): [number, number] => [(box.current?.clientWidth ?? 0) / 2, (box.current?.clientHeight ?? 0) / 2];
  return (
    <div className="canvas" ref={box} onPointerDown={onPointerDown}>
      <div className="canvas-inner" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {children}
      </div>
      <div className="zoom" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => zoomAt(1.2, ...center())} title="Zoom in">+</button>
        <button onClick={() => zoomAt(1 / 1.2, ...center())} title="Zoom out">−</button>
        <button onClick={fit} title="Fit">⤢</button>
      </div>
    </div>
  );
}
