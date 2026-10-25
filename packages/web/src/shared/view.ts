import type { AskReply, NodeView, TreeData } from "./types.js";

/** How well the reader knows the code (D40): picks text, starting level, and whether error paths and code names show. */
export type Familiarity = "new" | "familiar" | "expert";
export const FAMILIARITIES: Familiarity[] = ["new", "familiar", "expert"];

/** What the side panel is about. A stack of these lets the panel go back. */
export type Selection =
  | { kind: "node"; id: string }
  | { kind: "file"; path: string }
  | { kind: "fn"; id: string; entry?: string }
  | { kind: "entry"; id: string };

const fileOf = (fn: string): string => fn.slice(0, fn.indexOf("#"));

/** The folder that holds all the files (one file: its path); mixed folders: the top ones, most files first. */
export function folderName(files: string[]): string {
  if (files.length === 0) return "";
  if (files.length === 1) return files[0] ?? "";
  const dirs = files.map((f) => f.split("/").slice(0, -1));
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => d[i] !== undefined && d[i] === dirs[0]?.[i]); i++) common.push(dirs[0]?.[i] ?? "");
  if (common.length) return `${common.join("/")}/`;
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(d[0] ? `${d[0]}/` : "./", (counts.get(d[0] ? `${d[0]}/` : "./") ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([d]) => d);
  return top.slice(0, 3).join(", ") + (top.length > 3 ? ` +${top.length - 3}` : "");
}

/**
 * A part's code name: its folders, when no sibling has files in them and they don't just repeat the parent's name.
 * Otherwise (Claude often carves several parts out of one folder) its busiest file: siblings split their parent's
 * files, so that never repeats.
 */
export function partName(node: NodeView, data: TreeData): string {
  const folder = folderName(node.files);
  const parent = node.parent ? data.nodes[node.parent] : undefined;
  const ids = parent ? (Array.isArray(parent.children) ? parent.children : []) : data.parts;
  const siblingFiles = ids.filter((id) => id !== node.id).flatMap((id) => data.nodes[id]?.files ?? []);
  const dirs = folder.split(", ");
  const holds = (dir: string, file: string): boolean => (dir === "./" ? !file.includes("/") : file.startsWith(dir));
  const owned =
    node.files.length > 1 &&
    !folder.includes(" +") &&
    folder !== (parent ? folderName(parent.files) : undefined) &&
    !siblingFiles.some((f) => dirs.some((d) => holds(d, f)));
  if (owned) return folder;
  const [top = folder] = rankFiles(node.files, data);
  const more = node.files.length - 1;
  return more > 0 ? `${top} +${more} file${more === 1 ? "" : "s"}` : top;
}

/** Code names in place of prose, for the expert setting. */
export function codeName(node: NodeView, data: TreeData): string {
  if (node.kind === "part") return partName(node, data);
  if (node.kind === "system") return node.title;
  const names = node.functions.slice(0, 2).map((id) => `${data.refs[id]?.name ?? id}()`);
  return names.join(", ") + (node.functions.length > 2 ? ` +${node.functions.length - 2}` : "");
}

/** The line under a box's title. */
export function boxText(node: NodeView, data: TreeData, mode: Familiarity): string {
  return mode === "expert" ? codeName(node, data) : node.short;
}

/** The text that explains a node: long for newcomers, short when familiar, none for experts. */
export function panelText(node: NodeView, mode: Familiarity): string {
  return mode === "new" ? node.long : mode === "familiar" ? node.short : "";
}

/** A check step folds into one line unless the reader is new (D40). */
export const compactStep = (node: NodeView, mode: Familiarity): boolean => node.stepKind === "check" && mode !== "new";

/** A node's children as a canvas shows them: newcomers don't see error paths (D40). */
export function visibleChildren(node: NodeView, data: TreeData, mode: Familiarity): { shown: NodeView[]; hidden: number } {
  const all = Array.isArray(node.children) ? node.children.flatMap((id) => data.nodes[id] ?? []) : [];
  const shown = mode === "new" ? all.filter((n) => n.stepKind !== "error") : all;
  return { shown, hidden: all.length - shown.length };
}

/** A box opens when it has children or can get them (the Open pass); a leaf part opens into its files. */
export function canOpen(node: NodeView): boolean {
  return node.kind === "part" || node.kind === "journey" || Array.isArray(node.children) || node.children === "unopened";
}

/** The node and its ancestors, top first. */
export function pathTo(id: string, data: TreeData): NodeView[] {
  const path: NodeView[] = [];
  for (let at = data.nodes[id]; at; at = at.parent ? data.nodes[at.parent] : undefined) path.unshift(at);
  return path;
}

export function journeyOf(id: string, data: TreeData): NodeView | undefined {
  return pathTo(id, data).find((n) => n.kind === "journey");
}

/** The most specific part holding a file. */
export function deepestPart(file: string, data: TreeData): NodeView | undefined {
  let found: NodeView | undefined;
  let level = data.parts.flatMap((id) => data.nodes[id] ?? []);
  for (;;) {
    const next = level.find((n) => n.files.includes(file));
    if (!next) return found;
    found = next;
    level = Array.isArray(next.children) ? next.children.flatMap((id) => data.nodes[id] ?? []) : [];
  }
}

/** The parts a journey or step runs through, as specific as the tree goes. */
export function partsOf(node: NodeView, data: TreeData): NodeView[] {
  const found = new Map<string, NodeView>();
  for (const file of node.files) {
    const part = deepestPart(file, data);
    if (part) found.set(part.id, part);
  }
  return [...found.values()];
}

/** The steps whose code lies in these files, grouped by journey (the "used in" list of a part or system). */
export function usedIn(files: string[], data: TreeData): { journey: NodeView; steps: NodeView[] }[] {
  const wanted = new Set(files);
  const groups = new Map<string, { journey: NodeView; steps: NodeView[] }>();
  for (const id of data.journeys) {
    const journey = data.nodes[id];
    if (!journey || !Array.isArray(journey.children)) continue;
    const steps = journey.children.flatMap((c) => data.nodes[c] ?? []).filter((s) => s.files.some((f) => wanted.has(f)));
    if (steps.length) groups.set(id, { journey, steps });
  }
  return [...groups.values()];
}

/** Files a reader should see first: the ones most flows run through. */
export function rankFiles(files: string[], data: TreeData): string[] {
  return [...files].sort((a, b) => (data.files[b]?.flows ?? 0) - (data.files[a]?.flows ?? 0) || (a < b ? -1 : 1));
}

/** What lights up: boxes holding these files or systems, and (for answers) the cited boxes themselves. */
export type Scope = { files: Set<string>; systems: Set<string>; nodes?: Set<string> };

/**
 * What an answer points at (Build 5): cited files, the files of cited functions and boxes, cited systems, and the cited
 * boxes plus the steps of a cited journey (so its path can be played).
 */
export function answerScope(reply: AskReply, data: TreeData): Scope {
  const nodes = reply.nodes.flatMap((id) => data.nodes[id] ?? []);
  const steps = nodes.flatMap((n) => (n.kind === "journey" && Array.isArray(n.children) ? n.children : []));
  // Systems a cited file or function's file calls directly light up too (an upload route → Blob storage).
  const pointed = [...reply.files, ...reply.functions.map(fileOf)];
  const called = pointed.flatMap((f) => (data.files[f]?.systems ?? []).map((name) => `system:${name}`));
  return {
    files: new Set([...pointed, ...nodes.flatMap((n) => n.files)]),
    systems: new Set([...nodes.filter((n) => n.kind === "system").map((n) => n.id), ...called]),
    nodes: new Set([...reply.nodes, ...steps]),
  };
}

/** The files and systems a selection stands for: boxes holding them light up in both views. */
export function selectionScope(sel: Selection | undefined, data: TreeData): Scope {
  if (!sel) return { files: new Set(), systems: new Set() };
  if (sel.kind === "file") return { files: new Set([sel.path]), systems: new Set() };
  if (sel.kind === "fn") return { files: new Set([fileOf(sel.id)]), systems: new Set() };
  if (sel.kind === "entry") return { files: new Set(), systems: new Set() };
  const node = data.nodes[sel.id];
  if (!node) return { files: new Set(), systems: new Set() };
  return { files: new Set(node.files), systems: new Set(node.kind === "system" ? [node.id] : node.systems) };
}

/** Whether a box (by its files or system id) is part of the selection. */
export function inScope(scope: Scope, id: string, files: string[]): boolean {
  return scope.systems.has(id) || scope.nodes?.has(id) === true || files.some((f) => scope.files.has(f));
}
