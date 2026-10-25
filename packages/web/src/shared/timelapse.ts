import type { MapGraph, MapNode, TimelapseFrame } from "./types.js";

/** Keep union positions, but only render this frame and the boxes that just left it. */
export function frameGraph(layout: MapGraph, frame: TimelapseFrame, previous?: TimelapseFrame): { graph: MapGraph; status: Map<string, string> } {
  const present = new Map(frame.nodes.map((n) => [n.id, n]));
  const before = new Map(previous?.nodes.map((n) => [n.id, n]));
  const removed = new Set(frame.removed);
  const edges = new Set(frame.edges);
  const status = new Map<string, string>();
  const nodes = layout.nodes.flatMap((n) => {
    const now = present.get(n.id);
    if (!now && !removed.has(n.id)) return [];
    const text = now ?? before.get(n.id);
    status.set(n.id, now ? (now.status === "same" ? "" : now.status) : "removed");
    return [{ ...n, label: text?.title ?? n.label, description: text?.short ?? n.description }];
  });
  return { graph: { ...layout, nodes, edges: layout.edges.filter((e) => edges.has(e.id)) }, status };
}

/** Camera bounds only; no node coordinates change when focusing a frame or a box. */
export function nodeBounds(nodes: MapNode[]): { x: number; y: number; width: number; height: number } | undefined {
  if (!nodes.length) return undefined;
  const x = Math.min(...nodes.map((n) => n.x)) - 24;
  const y = Math.min(...nodes.map((n) => n.y)) - 24;
  return {
    x, y,
    width: Math.max(...nodes.map((n) => n.x + n.width)) - x + 24,
    height: Math.max(...nodes.map((n) => n.y + n.height)) - y + 24,
  };
}
