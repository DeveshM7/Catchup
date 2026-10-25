import { basename } from "node:path";
import { componentIndex } from "@catchup/analyzer";
import type { Understanding, UnderstandingNode } from "@catchup/agent";
import type { FileView, MapEdge, MapGraph, MapNode, NodeView, TreeData } from "../shared/types.js";
import { functionRef, markMain, type DashboardInputs } from "./data.js";
import { layoutMap } from "./layout.js";

export type TreeInputs = Pick<DashboardInputs, "repoRoot" | "facts" | "snapshot" | "signals"> & { understanding: Understanding };

/** Box sizes on an understanding canvas: fixed per kind, so positions depend only on ids and edges. */
export const BOX = { part: { width: 232, height: 96 }, file: { width: 232, height: 60 }, external: { width: 176, height: 58 } } as const;
/** Palette slot for nodes outside every top part. */
const NO_PART = 7;

const fileOf = (fn: string): string => fn.slice(0, fn.indexOf("#"));
const systemNodeId = (name: string): string => `system:${name}`;
const unique = <T>(items: T[]): T[] => [...new Set(items)];

function parentIndex(u: Understanding): Map<string, string> {
  const parent = new Map<string, string>();
  for (const node of Object.values(u.nodes)) if (Array.isArray(node.children)) for (const child of node.children) parent.set(child, node.id);
  return parent;
}

/** Top part holding each file. */
function topPartIndex(u: Understanding): Map<string, string> {
  const index = new Map<string, string>();
  for (const id of u.parts) for (const file of u.nodes[id]?.anchor.files ?? []) index.set(file, id);
  return index;
}

/** The top part holding most of the cited functions (ties: the one cited first). */
export function laneOf(functions: string[], partOfFile: Map<string, string>): string | undefined {
  const counts = new Map<string, number>();
  for (const fn of functions) {
    const part = partOfFile.get(fileOf(fn));
    if (part !== undefined) counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [part, n] of counts) if (best === undefined || n > (counts.get(best) ?? 0)) best = part;
  return best;
}

/** Everything the UI needs to draw and navigate the tree; no Claude calls. */
export function treeData(inputs: TreeInputs): TreeData {
  const { facts, snapshot, signals, understanding: u } = inputs;
  const componentOf = componentIndex(snapshot);
  const parent = parentIndex(u);
  const partOfFile = topPartIndex(u);
  const slot = new Map(u.parts.map((p, i) => [p, i]));
  const topOf = (id: string): string => {
    let at = id;
    for (let up = parent.get(at); up !== undefined; up = parent.get(at)) at = up;
    return at;
  };
  const view = (n: UnderstandingNode): NodeView => {
    const flow = n.kind === "journey" || n.kind === "step";
    const lane = flow ? laneOf(n.anchor.functions, partOfFile) : undefined;
    const top = n.kind === "part" ? topOf(n.id) : undefined;
    const parts = n.kind === "part" ? [top!] : n.kind === "system" ? unique(n.anchor.files.flatMap((f) => partOfFile.get(f) ?? [])) : (n.parts ?? []);
    return {
      id: n.id,
      kind: n.kind,
      title: n.title,
      short: n.short,
      long: n.long,
      ...(n.stepKind ? { stepKind: n.stepKind } : {}),
      depth: n.depth,
      children: n.children,
      parent: parent.get(n.id) ?? null,
      color: n.kind === "system" ? -1 : (slot.get(top ?? lane ?? "") ?? NO_PART),
      parts,
      systems: (n.systems ?? []).map(systemNodeId),
      files: n.anchor.files,
      functions: n.anchor.functions,
      ...(n.entry !== undefined ? { entry: n.entry } : {}),
      ...(lane !== undefined ? { lane } : {}),
    };
  };
  const byFile = new Map<string, string[]>();
  for (const fn of [...facts.functions].sort((a, b) => a.startLine - b.startLine)) byFile.set(fn.file, [...(byFile.get(fn.file) ?? []), fn.id]);
  const files: Record<string, FileView> = Object.fromEntries(
    facts.files.map((f) => [
      f.path,
      {
        path: f.path,
        loc: f.loc,
        ...(f.side ? { side: f.side } : {}),
        flows: signals.files[f.path]?.flows ?? 0,
        systems: signals.files[f.path]?.systems ?? [],
        functions: byFile.get(f.path) ?? [],
      },
    ]),
  );
  const extras = u.extras ? { glossary: u.extras.glossary, startHere: u.extras.startHere, changes: u.extras.changes, surprises: u.extras.surprises } : null;
  return {
    repo: basename(inputs.repoRoot),
    sha: u.sha,
    model: u.model,
    summary: u.summary,
    parts: u.parts,
    journeys: u.journeys,
    systems: u.systems,
    otherFlows: u.otherFlows,
    extras,
    nodes: Object.fromEntries(Object.values(u.nodes).map((n) => [n.id, view(n)])),
    files,
    refs: Object.fromEntries(facts.functions.map((f) => [f.id, functionRef(f, f.id, componentOf)])),
  };
}

type Member = Omit<MapNode, "x" | "y" | "width" | "height"> & { anchor: string[] };

function partMember(node: UnderstandingNode, color: number, functionsIn: (files: string[]) => number): Member {
  return { id: node.id, label: node.title, description: node.short, kind: "part", files: node.anchor.files.length, functions: functionsIn(node.anchor.files), color, anchor: node.anchor.files };
}

/** The boxes one canvas shows: the top parts (`root`), a part's children, or a leaf part's files. */
function members(inputs: TreeInputs, id: string, filesWhenUnopened = false): Member[] | undefined {
  const u = inputs.understanding;
  const counts = new Map<string, number>();
  for (const fn of inputs.facts.functions) counts.set(fn.file, (counts.get(fn.file) ?? 0) + 1);
  const functionsIn = (files: string[]): number => files.reduce((n, f) => n + (counts.get(f) ?? 0), 0);
  if (id === "root") return u.parts.flatMap((p, i) => (u.nodes[p] ? [partMember(u.nodes[p], i, functionsIn)] : []));
  const node = u.nodes[id];
  if (!node || node.kind !== "part") return undefined;
  const parent = parentIndex(u);
  let top = id;
  for (let up = parent.get(top); up !== undefined; up = parent.get(top)) top = up;
  const color = Math.max(0, u.parts.indexOf(top));
  if (Array.isArray(node.children)) return node.children.flatMap((c) => (u.nodes[c] ? [partMember(u.nodes[c], color, functionsIn)] : []));
  if (node.children === "unopened" && !filesWhenUnopened) return undefined;
  const loc = new Map(inputs.facts.files.map((f) => [f.path, f.loc]));
  return node.anchor.files.map((f) => ({
    id: `file:${f}`,
    label: f,
    description: `${loc.get(f) ?? 0} lines · ${counts.get(f) ?? 0} functions`,
    kind: "file",
    files: 1,
    functions: counts.get(f) ?? 0,
    color,
    anchor: [f],
  }));
}

/**
 * One canvas (ARCHITECTURE "Rendering"): the boxes, links between them weighted by the calls and imports that cross
 * (each box's 3 strongest drawn), and the outside systems their files call. Laid out by elkjs, so the same tree
 * always draws the same picture. Undefined for a node that isn't a part or isn't opened yet (with `filesWhenUnopened`,
 * as the live preview asks since it can't run Open, an unopened part shows its files).
 */
export async function canvasGraph(inputs: TreeInputs, id: string, options: { filesWhenUnopened?: boolean } = {}): Promise<MapGraph | undefined> {
  const list = members(inputs, id, options.filesWhenUnopened);
  if (!list) return undefined;
  const owner = new Map<string, string>();
  for (const m of list) for (const f of m.anchor) owner.set(f, m.id);
  const weights = new Map<string, number>();
  const link = (fromFile: string, toFile: string): void => {
    const a = owner.get(fromFile);
    const b = owner.get(toFile);
    if (a === undefined || b === undefined || a === b) return;
    weights.set(`${a}->${b}`, (weights.get(`${a}->${b}`) ?? 0) + 1);
  };
  for (const call of inputs.facts.calls) if (call.to !== null) link(fileOf(call.from), fileOf(call.to));
  for (const imp of inputs.facts.imports) link(imp.from, imp.to);
  const edges: MapEdge[] = [...weights].map(([key, weight]) => {
    const [from, to] = key.split("->") as [string, string];
    return { id: key, from, to, weight, kind: "import", main: false };
  });
  const systems = new Set<string>();
  const tools = new Set(inputs.snapshot.externals.flatMap((e) => (e.kind === "tool" ? [e.name] : [])));
  for (const m of list) {
    for (const name of unique(m.anchor.flatMap((f) => inputs.signals.files[f]?.systems ?? [])).sort()) {
      systems.add(name);
      edges.push({ id: `${m.id}->${systemNodeId(name)}`, from: m.id, to: systemNodeId(name), weight: 1, kind: "uses", main: true });
    }
  }
  const nodes: Omit<MapNode, "x" | "y" | "width" | "height">[] = [
    ...list.map(({ id, label, description, kind, files, functions, color }) => ({ id, label, description, kind, files, functions, color })),
    ...[...systems].sort().map((name) => ({ id: systemNodeId(name), label: name, description: tools.has(name) ? "Outside tool" : "Outside system", kind: "external" as const, files: 0, functions: 0, color: -1 })),
  ];
  return layoutMap(nodes, markMain(edges), (n) => BOX[n.kind === "file" ? "file" : n.kind === "external" ? "external" : "part"]);
}
