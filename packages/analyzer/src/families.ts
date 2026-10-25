import type { CallTree, TreeNode } from "./calltree.js";
import { compareStrings } from "./sort.js";

/** Entry points whose call trees share at least this share of functions belong to one family (D32). */
export const FAMILY_OVERLAP = 0.6;

export type FlowFamily = {
  /** Smallest member entry point id: stays put while members come and go. */
  id: string;
  /** Entry point id of the member most like the others; the one to explain. */
  representative: string;
  /** Entry point ids, best score first. */
  members: string[];
  /** Best member's score: files touched + 3 × systems + 2 × components. */
  score: number;
  systems: string[];
};

type Reach = { entry: string; label: string; functions: Set<string>; score: number; systems: string[] };

function reachOf(tree: CallTree): Reach {
  const functions = new Set<string>();
  const files = new Set<string>();
  const components = new Set<string>();
  const walk = (node: TreeNode, isRoot: boolean): void => {
    if (node.kind !== "function") return;
    if (!isRoot) functions.add(node.fn);
    files.add(node.fn.slice(0, node.fn.indexOf("#")));
    components.add(node.component);
    for (const child of node.children) walk(child, false);
  };
  walk(tree.root, true);
  const score = files.size + 3 * tree.systems.length + 2 * components.size;
  return { entry: tree.entryPoint.id, label: tree.entryPoint.label, functions, score, systems: tree.systems };
}

export function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const fn of a) if (b.has(fn)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function byScore(a: Reach, b: Reach): number {
  return b.score - a.score || compareStrings(a.label, b.label);
}

/** The member with the highest average overlap with the others; ties go to score order. */
function representativeOf(members: Reach[]): Reach {
  let best = members[0]!;
  let bestAverage = -1;
  for (const candidate of members) {
    const others = members.filter((m) => m !== candidate);
    const average = others.length === 0 ? 0 : others.reduce((sum, m) => sum + overlap(candidate.functions, m.functions), 0) / others.length;
    if (average > bestAverage) {
      best = candidate;
      bestAverage = average;
    }
  }
  return best;
}

/**
 * Groups entry points that run mostly the same code (D32) and ranks the groups.
 * Greedy in score order: each tree joins the first family whose founder it overlaps enough.
 */
export function flowFamilies(trees: CallTree[]): FlowFamily[] {
  // Pages and layouts are screens, not journeys: what a user does there has its own `ui:` entry point.
  const reaches = trees.filter((t) => t.entryPoint.kind !== "page").map(reachOf).sort(byScore);
  const groups: { founder: Reach; members: Reach[] }[] = [];
  for (const reach of reaches) {
    const group = groups.find((g) => overlap(g.founder.functions, reach.functions) >= FAMILY_OVERLAP);
    if (group) group.members.push(reach);
    else groups.push({ founder: reach, members: [reach] });
  }
  const families = groups.map(({ members }): FlowFamily => {
    const representative = representativeOf(members);
    return {
      id: members.map((m) => m.entry).sort(compareStrings)[0]!,
      representative: representative.entry,
      members: members.map((m) => m.entry),
      score: members[0]!.score,
      systems: representative.systems,
    };
  });
  return families.sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
}
