import { describe, expect, it } from "vitest";
import { layoutMap } from "./server/layout.js";

const nodes = [
  { id: "a", label: "Alpha", description: "", kind: "component" as const, files: 3, functions: 5, color: 0 },
  { id: "b", label: "Beta", description: "", kind: "component" as const, files: 2, functions: 1, color: 0 },
  { id: "db", label: "Postgres", description: "", kind: "external" as const, files: 0, functions: 0, color: 0 },
];
const edges = [
  { id: "a->b", from: "a", to: "b", weight: 2, kind: "import" as const, main: true },
  { id: "b->db", from: "b", to: "db", weight: 1, kind: "uses" as const, main: true },
];

describe("layoutMap", () => {
  it("places importers above what they import", async () => {
    const placed = await layoutMap(nodes, edges);
    const y = new Map(placed.nodes.map((n) => [n.id, n.y]));
    expect(y.get("a")).toBeLessThan(y.get("b") ?? 0);
    expect(y.get("b")).toBeLessThan(y.get("db") ?? 0);
  });

  it("routes main edges with right angles", async () => {
    const { edges: routed } = await layoutMap(nodes, edges);
    for (const edge of routed) {
      const points = edge.points ?? [];
      expect(points.length).toBeGreaterThanOrEqual(2);
      points.slice(1).forEach((p, i) => {
        const q = points[i];
        expect(q && (p.x === q.x || p.y === q.y)).toBe(true);
      });
    }
  });

  it("gives the same positions every time", async () => {
    expect(await layoutMap(nodes, edges)).toEqual(await layoutMap(nodes, edges));
  });
});
