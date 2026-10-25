import { basename } from "node:path";
import type { CallTree, Facts, FunctionFact, FunctionTreeNode, Signals, Snapshot, TreeNode } from "@catchup/analyzer";
import { componentIndex } from "@catchup/analyzer";
import type { Understanding } from "@catchup/agent";
import type { EntryView, FunctionRef, MapData, MapEdge, MapNode, TreeNodeView, TreeView } from "../shared/types.js";
import { layoutMap } from "./layout.js";

export type DashboardInputs = {
  repoRoot: string;
  facts: Facts;
  snapshot: Snapshot;
  trees: CallTree[];
  signals: Signals;
  /** The stored understanding tree for this commit, if `catchup understand` ran. */
  understanding?: Understanding;
  /** Runs the Open pass for one node (D38) and returns the saved tree. Absent: nodes can't be opened from the UI. */
  open?: (understanding: Understanding, id: string) => Promise<Understanding>;
};

export function functionRef(fact: FunctionFact | undefined, id: string, componentOf: Map<string, string>): FunctionRef {
  const file = fact?.file ?? id.slice(0, id.indexOf("#"));
  return {
    id,
    name: fact?.name ?? id.slice(id.indexOf("#") + 1),
    file,
    startLine: fact?.startLine ?? 0,
    endLine: fact?.endLine ?? 0,
    component: componentOf.get(file) ?? "?",
  };
}

/** Edges each node shows by default: its strongest links, plus every outside system it uses. */
const MAIN_PER_NODE = 3;

/** Marks each source's strongest edges as main; outside-system edges are always main (D27). */
export function markMain(edges: MapEdge[]): MapEdge[] {
  const marked = edges.map((e) => ({ ...e, main: e.kind === "uses" }));
  const byFrom = new Map<string, MapEdge[]>();
  for (const edge of marked) if (edge.kind === "import") byFrom.set(edge.from, [...(byFrom.get(edge.from) ?? []), edge]);
  for (const list of byFrom.values()) {
    list.sort((a, b) => b.weight - a.weight || (a.to < b.to ? -1 : 1));
    for (const edge of list.slice(0, MAIN_PER_NODE)) edge.main = true;
  }
  return marked;
}

function mapEdges(snapshot: Snapshot): MapEdge[] {
  const imports: MapEdge[] = snapshot.edges.map((e) => ({ id: `${e.from}->${e.to}`, from: e.from, to: e.to, weight: e.weight, kind: "import", main: false }));
  const uses: MapEdge[] = snapshot.externals.flatMap((ext) =>
    ext.usedBy.map((c): MapEdge => ({ id: `${c}->${ext.id}`, from: c, to: ext.id, weight: 1, kind: "uses", main: true })),
  );
  return markMain([...imports, ...uses]);
}

/** The full map: every D19 component and outside system, plus the entry points (no Claude text). */
export async function buildMap(inputs: DashboardInputs): Promise<MapData> {
  const { facts, snapshot, trees } = inputs;
  const nodes: Omit<MapNode, "x" | "y" | "width" | "height">[] = [
    ...snapshot.components.map((c, i) => ({ id: c.id, label: c.name, description: c.id, kind: "component" as const, files: c.files.length, functions: c.functionCount, color: i })),
    ...snapshot.externals.map((e) => ({
      id: e.id,
      label: e.name,
      description: `Outside system (${e.packages.join(", ")})`,
      kind: "external" as const,
      files: 0,
      functions: 0,
      color: -1,
    })),
  ];
  const entries: EntryView[] = trees.map((t) => ({ id: t.entryPoint.id, label: t.entryPoint.label, systems: t.systems, functionCount: t.functionCount }));
  return { repo: basename(inputs.repoRoot), sha: facts.sha, map: await layoutMap(nodes, mapEdges(snapshot)), entries };
}

function siteFlags(node: TreeNode): string[] {
  const site = node.site;
  return [
    site?.onError ? "on error" : site?.conditional ? "if" : "",
    site?.parallel ? "parallel" : "",
    site?.oneOf ? "one of" : "",
    site?.passed ? "callback" : "",
    site?.tool ? "AI tool" : "",
    site?.remote ? `request → ${site.remote}` : "",
    site?.message ? `message ${site.message}` : "",
    node.kind === "external" && node.writes ? "writes" : "",
    node.kind === "function" && node.stop === "repeat" ? "shown above" : "",
    node.kind === "function" && node.stop === "cycle" ? "recursive" : "",
    node.kind === "function" && node.stop === "event" ? "user action" : "",
    node.kind === "function" && node.stop === "message" ? "handles it in the browser" : "",
    node.kind === "function" && (node.stop === "depth" || node.stop === "size") ? "limit" : "",
  ].filter(Boolean);
}

export function treeView(tree: CallTree, facts: Facts, snapshot: Snapshot): TreeView {
  const componentOf = componentIndex(snapshot);
  const functions = new Map(facts.functions.map((f) => [f.id, f]));
  const convert = (node: TreeNode): TreeNodeView => {
    const flags = siteFlags(node);
    if (node.kind === "function") {
      return { kind: "function", fn: functionRef(functions.get(node.fn), node.fn, componentOf), importance: node.importance, flags, children: node.children.map(convert) };
    }
    const label = node.kind === "external" ? `${node.system ?? node.package}: ${node.callee}` : node.callee;
    return { kind: node.kind, label, importance: node.importance, flags };
  };
  return { entry: tree.entryPoint.id, label: tree.entryPoint.label, partial: tree.partial, systems: tree.systems, root: convert(tree.root) };
}

/**
 * The call subtree under `fn`, as the bottom level of a box: from `entry`'s tree when it reaches `fn`, else from
 * the tree where `fn` calls the most. Undefined when no tree reaches `fn`.
 */
export function callsOf(inputs: Pick<DashboardInputs, "facts" | "snapshot" | "trees">, fn: string, entry?: string): TreeView | undefined {
  const nodeIn = (tree: CallTree): FunctionTreeNode | undefined => {
    let best: FunctionTreeNode | undefined;
    const walk = (node: TreeNode): void => {
      if (node.kind !== "function") return;
      if (node.fn === fn && (!best || node.children.length > best.children.length)) best = node;
      node.children.forEach(walk);
    };
    walk(tree.root);
    return best;
  };
  const preferred = entry === undefined ? undefined : inputs.trees.find((t) => t.entryPoint.id === entry);
  const fromEntry = preferred && nodeIn(preferred);
  if (preferred && fromEntry) return treeView({ ...preferred, root: fromEntry }, inputs.facts, inputs.snapshot);
  let found: { tree: CallTree; node: FunctionTreeNode } | undefined;
  for (const tree of inputs.trees) {
    const node = nodeIn(tree);
    if (node && (!found || node.children.length > found.node.children.length)) found = { tree, node };
  }
  return found && treeView({ ...found.tree, root: found.node }, inputs.facts, inputs.snapshot);
}
