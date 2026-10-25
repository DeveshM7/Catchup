import type { Point, StepKind } from "./types.js";

export const FLOW = { stepWidth: 196, stepHeight: 140, colGap: 40, header: 34, laneGap: 14, lanePad: 14, systemHeight: 54, maxChips: 3, pad: 16 } as const;

/** A step as the lane layout needs it: which lane (top part) it sits in and which systems it calls. */
export type LaneStep = { id: string; lane: string; systems: string[]; kind: StepKind };

export type FlowLane = { id: string; index: number; kind: "part" | "systems"; x: number; y: number; width: number; height: number };
export type FlowBox = { id: string; index: number; lane: string; x: number; y: number; width: number; height: number };
export type FlowEdge = { id: string; from: string; to: string; kind: StepKind; points: Point[] };
export type FlowLayout = { lanes: FlowLane[]; steps: FlowBox[]; systems: FlowBox[]; edges: FlowEdge[]; width: number; height: number };

type Cell = { lane: number; col: number };

/** Branch and error steps are side paths: they hang off the main step before them instead of joining the line. */
const isSide = (kind: StepKind): boolean => kind === "branch" || kind === "error";

/**
 * Places steps on a grid of lanes (rows, one per part in the order the steps first reach it) and columns.
 * The main path goes down within a column while it moves to lower lanes and takes the next column otherwise, so
 * it never doubles back. Side paths sit in their own lane in the first column whose path from their origin is clear.
 */
function placeSteps(input: LaneStep[], laneIndex: Map<string, number>): { cells: Cell[]; origin: (number | undefined)[] } {
  const taken = new Set<string>();
  const key = (lane: number, col: number): string => `${lane}:${col}`;
  const cells: Cell[] = [];
  const origin: (number | undefined)[] = [];
  let prev: Cell | undefined;
  let lastMain: number | undefined;
  input.forEach((step, i) => {
    const lane = laneIndex.get(step.lane) ?? 0;
    if (isSide(step.kind) && lastMain !== undefined) {
      origin[i] = lastMain;
      return;
    }
    let col = prev ? prev.col : 0;
    if (prev && lane > prev.lane && !taken.has(key(lane, col))) {
      for (let l = prev.lane + 1; l < lane; l++) taken.add(key(l, col));
    } else if (prev) col += 1;
    taken.add(key(lane, col));
    cells[i] = { lane, col };
    prev = cells[i];
    lastMain = i;
  });
  input.forEach((step, i) => {
    const from = origin[i] === undefined ? undefined : cells[origin[i]];
    if (!from) return;
    const lane = laneIndex.get(step.lane) ?? 0;
    for (let col = from.col; ; col++) {
      if (taken.has(key(lane, col))) continue;
      const between =
        col === from.col
          ? Array.from({ length: Math.max(0, Math.abs(lane - from.lane) - 1) }, (_, k) => key(Math.min(lane, from.lane) + 1 + k, col))
          : Array.from({ length: col - from.col - 1 }, (_, k) => key(lane, from.col + 1 + k));
      if (col === from.col && lane === from.lane) continue;
      if (between.some((c) => taken.has(c))) continue;
      for (const c of between) taken.add(c);
      taken.add(key(lane, col));
      cells[i] = { lane, col };
      return;
    }
  });
  return { cells, origin };
}

/** An orthogonal route between two boxes: straight down/up within a column, else through the gap after `a`. */
function route(a: FlowBox, b: FlowBox, offset: number): Point[] {
  const cx = a.x + a.width / 2;
  if (a.x === b.x) return b.y > a.y ? [{ x: cx, y: a.y + a.height }, { x: cx, y: b.y }] : [{ x: cx, y: a.y }, { x: cx, y: b.y + b.height }];
  const start = { x: a.x + a.width, y: a.y + a.height / 2 };
  const end = { x: b.x, y: b.y + b.height / 2 };
  if (start.y === end.y) return [start, end];
  const mid = start.x + FLOW.colGap / 2 + offset;
  return [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
}

/** A journey's steps on lanes, with outside systems in a last row under the first step that calls them. Pure and deterministic. */
export function flowLayout(input: LaneStep[]): FlowLayout {
  const { stepWidth, stepHeight, colGap, header, laneGap, lanePad, systemHeight, pad } = FLOW;
  const laneIds = [...new Set(input.map((s) => s.lane))];
  const laneIndex = new Map(laneIds.map((id, i) => [id, i]));
  const { cells, origin } = placeSteps(input, laneIndex);
  const columns = Math.max(1, ...cells.map((c) => (c ? c.col + 1 : 0)));
  const colX = (i: number): number => pad + lanePad + i * (stepWidth + colGap);
  const laneHeight = header + stepHeight + lanePad;
  const laneY = (i: number): number => pad + i * (laneHeight + laneGap);
  const innerWidth = columns * (stepWidth + colGap) - colGap + 2 * lanePad;

  const lanes: FlowLane[] = laneIds.map((id, i) => ({ id, index: i, kind: "part", x: pad, y: laneY(i), width: innerWidth, height: laneHeight }));
  const steps: FlowBox[] = input.map((step, i) => {
    const cell = cells[i] ?? { lane: 0, col: 0 };
    return { id: step.id, index: i, lane: step.lane, x: colX(cell.col), y: laneY(cell.lane) + header, width: stepWidth, height: stepHeight };
  });

  const systems: FlowBox[] = [];
  const firstCol = (id: string): number => Math.min(...input.flatMap((s, i) => (s.systems.includes(id) ? [cells[i]?.col ?? 0] : [])));
  const systemIds = [...new Set(input.flatMap((s) => s.systems))].sort((a, b) => firstCol(a) - firstCol(b));
  if (systemIds.length) {
    const y = laneY(laneIds.length);
    let nextFree = 0;
    for (const id of systemIds) {
      const x = Math.max(colX(firstCol(id)), nextFree);
      systems.push({ id, index: systems.length, lane: "systems", x, y: y + header, width: stepWidth, height: systemHeight });
      nextFree = x + stepWidth + 12;
    }
    const right = Math.max(innerWidth, nextFree - 12 + lanePad - pad);
    lanes.push({ id: "systems", index: laneIds.length, kind: "systems", x: pad, y, width: right, height: header + systemHeight + lanePad });
    for (const lane of lanes) lane.width = right;
  }

  const edges: FlowEdge[] = [];
  const sideRoutes = new Map<number, number>();
  let prevMain: number | undefined;
  input.forEach((step, i) => {
    const from = origin[i] ?? prevMain;
    if (origin[i] === undefined) prevMain = i;
    const a = from === undefined ? undefined : steps[from];
    const b = steps[i];
    if (!a || !b) return;
    // Each side route through a gap runs a little further right, so no two routes share a line.
    const used = isSide(step.kind) ? (sideRoutes.get(a.x) ?? 0) + 1 : 0;
    if (used) sideRoutes.set(a.x, used);
    edges.push({ id: `${a.id}->${b.id}`, from: a.id, to: b.id, kind: step.kind, points: route(a, b, used * 7) });
  });

  const last = lanes.at(-1);
  const width = pad + Math.max(...lanes.map((l) => l.width), innerWidth) + pad;
  const height = (last ? last.y + last.height : pad) + pad;
  return { lanes, steps, systems, edges, width, height };
}
