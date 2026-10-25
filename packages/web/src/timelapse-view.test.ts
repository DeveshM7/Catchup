import { describe, expect, it } from "vitest";
import { frameGraph, nodeBounds } from "./shared/timelapse.js";
import type { MapGraph, TimelapseFrame } from "./shared/types.js";

const layout: MapGraph = {
  width: 1000, height: 1000, edges: [],
  nodes: ["a", "b", "future"].map((id, i) => ({ id, kind: "part", color: 0, label: "Latest name", description: "Latest text", files: 1, functions: 1, x: i * 200, y: 50, width: 100, height: 80 })),
};
const frame: TimelapseFrame = { sha: "b", date: "", subject: "", tags: [], summary: "", journeys: [], nodes: [{ id: "a", title: "Current", short: "Now", status: "same" }], removed: ["b"], edges: [] };

describe("timelapse display", () => {
  it("hides future boxes and uses the previous frame's label for removed ones", () => {
    const previous = { ...frame, nodes: [{ id: "b", title: "Old name", short: "Old text", status: "same" as const }] };
    const drawn = frameGraph(layout, frame, previous);
    expect(drawn.graph.nodes.map((n) => [n.id, n.label, n.x])).toEqual([["a", "Current", 0], ["b", "Old name", 200]]);
    expect(drawn.status.get("b")).toBe("removed");
    expect(drawn.graph.width).toBe(layout.width);
  });

  it("focuses camera bounds without moving any boxes", () => {
    const before = structuredClone(layout);
    expect(nodeBounds([layout.nodes[0]!])).toEqual({ x: -24, y: 26, width: 148, height: 128 });
    expect(nodeBounds([])).toBeUndefined();
    expect(layout).toEqual(before);
  });
});
