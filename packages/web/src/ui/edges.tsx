import type { Point } from "../shared/types";

/** SVG path through orthogonal points with rounded corners. */
export function roundedPath(points: Point[], radius = 10): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M ${first.x} ${first.y}`;
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i];
    const prev = points[i];
    const next = rest[i + 1];
    if (!p || !prev) continue;
    if (!next) {
      d += ` L ${p.x} ${p.y}`;
      continue;
    }
    const r = Math.min(radius, dist(prev, p) / 2, dist(p, next) / 2);
    const a = toward(p, prev, r);
    const b = toward(p, next, r);
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`;
  }
  return d;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function toward(from: Point, to: Point, r: number): Point {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / d) * r, y: from.y + ((to.y - from.y) / d) * r };
}

/** Arrowhead markers, one per color. */
export function Markers({ colors }: { colors: string[] }) {
  return (
    <defs>
      {[...new Set(colors)].map((c) => (
        <marker key={c} id={markerId(c)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
        </marker>
      ))}
    </defs>
  );
}

export const markerId = (color: string): string => `arrow-${color.replace("#", "")}`;
