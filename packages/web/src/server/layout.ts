import elkModule from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { MapEdge, MapGraph, MapNode, Point } from "../shared/types.js";

const CHAR_WIDTH = 7.4;
const WIDTH = 176;
const LINE_HEIGHT = 18;
/** Title padding plus the subtitle line. */
const BASE_HEIGHT = 40;

type Unplaced = Omit<MapNode, "x" | "y" | "width" | "height">;

export function nodeSize(label: string): { width: number; height: number } {
  const lines = Math.max(1, Math.ceil((label.length * CHAR_WIDTH + 40) / WIDTH));
  return { width: WIDTH, height: BASE_HEIGHT + lines * LINE_HEIGHT };
}

/**
 * Deterministic layered layout with orthogonal edge routes (elkjs); the same graph always gets
 * the same picture (D10). Only `main` edges shape the layout and get routes: with every import
 * edge the layers get too wide to read.
 */
export async function layoutMap(nodes: Unplaced[], edges: MapEdge[], sizeOf: (node: Unplaced) => { width: number; height: number } = (n) => nodeSize(n.label)): Promise<MapGraph> {
  // CommonJS bundle: under NodeNext the default import is module.exports, which carries the class as `.default`.
  const elk = new elkModule.default();
  const main = edges.filter((e) => e.main);
  const input: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "28",
      "elk.spacing.edgeNode": "14",
      "elk.spacing.edgeEdge": "8",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      // Packs disconnected parts below the main graph instead of beside it.
      "elk.aspectRatio": "1.0",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.randomSeed": "1",
    },
    children: nodes.map((n) => ({ id: n.id, ...sizeOf(n) })),
    edges: main.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const graph = await elk.layout(input);
  const placed = new Map((graph.children ?? []).map((c) => [c.id, c]));
  const routes = new Map<string, Point[]>();
  for (const edge of graph.edges ?? []) {
    const section = edge.sections?.[0];
    if (!section) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    routes.set(edge.id, points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
  }
  return {
    nodes: nodes.map((n) => {
      const p = placed.get(n.id);
      return { ...n, x: Math.round(p?.x ?? 0), y: Math.round(p?.y ?? 0), ...sizeOf(n) };
    }),
    edges: edges.map((e) => {
      const points = routes.get(e.id);
      return points ? { ...e, points } : e;
    }),
    width: Math.round(graph.width ?? 0),
    height: Math.round(graph.height ?? 0),
  };
}
