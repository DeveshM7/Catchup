import { describe, expect, it } from "vitest";
import { flowLayout, type FlowBox, type LaneStep } from "./shared/flowLayout.js";

const step = (id: string, lane: string, systems: string[] = [], kind: LaneStep["kind"] = "main"): LaneStep => ({ id, lane, systems, kind });
const steps = [step("s1", "api"), step("s2", "lib", ["system:db", "system:cache"]), step("s3", "api", [], "error")];
const overlaps = (a: FlowBox, b: FlowBox): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("flowLayout", () => {
  const layout = flowLayout(steps);

  it("puts each step inside its lane", () => {
    for (const box of layout.steps) {
      const lane = layout.lanes.find((l) => l.id === box.lane);
      expect(lane && box.y >= lane.y && box.y + box.height <= lane.y + lane.height && box.x + box.width <= lane.x + lane.width).toBe(true);
    }
  });

  it("puts one lane per part in first-reached order, then systems", () => {
    expect(layout.lanes.map((l) => l.id)).toEqual(["api", "lib", "systems"]);
    expect(layout.steps.map((s) => s.lane)).toEqual(["api", "lib", "api"]);
  });

  it("keeps the main path in one column while it goes down, and never overlaps boxes", () => {
    const [s1, s2, s3] = layout.steps;
    expect(s1 && s2 && s2.x === s1.x && s2.y > s1.y).toBe(true);
    expect(s3 && s2 && s3.x > s2.x).toBe(true);
    for (const a of layout.steps) for (const b of layout.steps) if (a !== b) expect(overlaps(a, b)).toBe(false);
    const [db, cache] = layout.systems;
    expect(db && cache && cache.x >= db.x + db.width).toBe(true);
  });

  it("hangs side paths off the main step before them; the main path skips them", () => {
    const side = flowLayout([step("a", "api"), step("b", "api", [], "branch"), step("c", "lib")]);
    expect(side.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ["a", "b", "branch"],
      ["a", "c", "main"],
    ]);
    expect(layout.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ["s1", "s2", "main"],
      ["s2", "s3", "error"],
    ]);
  });

  it("draws orthogonal edges", () => {
    for (const edge of layout.edges) {
      edge.points.slice(1).forEach((p, i) => {
        const q = edge.points[i];
        expect(q && (p.x === q.x || p.y === q.y)).toBe(true);
      });
    }
  });

  it("routes around an occupied row instead of searching forever", () => {
    const input = [step("a", "api"), step("branch", "api", [], "branch"), step("b", "api"), step("error", "api", [], "error"), step("c", "api")];
    const graph = flowLayout(input);
    expect(graph.steps).toHaveLength(5);
    for (const a of graph.steps) for (const b of graph.steps) if (a !== b) expect(overlaps(a, b)).toBe(false);
    for (const edge of graph.edges) {
      for (let i = 1; i < edge.points.length; i++) {
        const a = edge.points[i - 1]!;
        const b = edge.points[i]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const box of graph.steps.filter((n) => n.id !== edge.from && n.id !== edge.to)) {
          const crosses = a.x === b.x
            ? a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height
            : a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
          expect(crosses).toBe(false);
        }
      }
    }
    expect(flowLayout(input)).toEqual(graph);
  });

  it("handles an empty journey with finite dimensions", () => {
    const graph = flowLayout([]);
    expect(graph.steps).toEqual([]);
    expect(Number.isFinite(graph.width) && Number.isFinite(graph.height)).toBe(true);
  });

  it("is deterministic", () => {
    expect(flowLayout(steps)).toEqual(layout);
  });
});
