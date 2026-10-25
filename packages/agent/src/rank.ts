import type { CallTree, TreeNode } from "@catchup/analyzer";

const PER_GROUP = 2;

function countImportant(node: TreeNode): number {
  if (node.kind !== "function") return node.importance === "important" ? 1 : 0;
  return (node.importance === "important" ? 1 : 0) + node.children.reduce((n, c) => n + countImportant(c), 0);
}

export function componentsOf(tree: CallTree): string[] {
  const seen = new Set<string>();
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    seen.add(node.component);
    node.children.forEach(walk);
  };
  walk(tree.root);
  return [...seen].sort();
}

/** `GET /api/websites/[id]/stats` → `websites`: flows sharing it are near-duplicates for ranking. */
function groupOf(label: string): string {
  const path = label.split(" ").at(-1) ?? label;
  const segments = path.split("/").filter((s) => s && s !== "api" && !s.startsWith("[") && !s.startsWith(":"));
  return segments[0] ?? path;
}

export function flowScore(tree: CallTree): number {
  return tree.systems.length * 10 + componentsOf(tree).length * 2 + countImportant(tree.root);
}

/** The `count` most important flows, at most two per route group, deterministic order (D24). */
export function selectTopFlows(trees: CallTree[], count: number): CallTree[] {
  const ranked = [...trees].sort(
    (a, b) => flowScore(b) - flowScore(a) || (a.entryPoint.id < b.entryPoint.id ? -1 : a.entryPoint.id > b.entryPoint.id ? 1 : 0),
  );
  const perGroup = new Map<string, number>();
  const chosen: CallTree[] = [];
  for (const tree of ranked) {
    if (chosen.length >= count) break;
    const group = groupOf(tree.entryPoint.label);
    const n = perGroup.get(group) ?? 0;
    if (n >= PER_GROUP) continue;
    perGroup.set(group, n + 1);
    chosen.push(tree);
  }
  return chosen;
}
