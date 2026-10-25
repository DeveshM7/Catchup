import type { CallTree, FunctionTreeNode, TreeNode } from "@catchup/analyzer";

/** For each function, the functions that call it on some path from the root (its enclosing code). */
export function callersOf(tree: CallTree): Map<string, Set<string>> {
  const callers = new Map<string, Set<string>>();
  const walk = (node: TreeNode, path: string[]): void => {
    if (node.kind !== "function") return;
    const set = callers.get(node.fn) ?? new Set<string>();
    for (const fn of path) set.add(fn);
    callers.set(node.fn, set);
    node.children.forEach((c) => walk(c, [...path, node.fn]));
  };
  walk(tree.root, []);
  return callers;
}

/** Each function's first position in the call tree, in the order calls run (preorder). */
export function preorder(tree: CallTree): Map<string, number> {
  const order = new Map<string, number>();
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    if (!order.has(node.fn)) order.set(node.fn, order.size);
    node.children.forEach(walk);
  };
  walk(tree.root);
  return order;
}

/**
 * Functions a journey's steps must cover (ARCHITECTURE §7): the handler, AI tools, requests across to the server,
 * and the browser functions that receive streamed messages. The requests one function makes form one group:
 * covering any of them is enough (the step crosses to the server there).
 */
export function keyFunctionGroups(tree: CallTree): string[][] {
  const groups = new Map<string, Set<string>>();
  const add = (key: string, fn: string): void => {
    groups.set(key, (groups.get(key) ?? new Set()).add(fn));
  };
  add(tree.root.fn, tree.root.fn);
  const walk = (node: FunctionTreeNode): void => {
    for (const child of node.children) {
      if (child.kind !== "function") continue;
      const site = child.site;
      if (site?.tool || site?.message) add(child.fn, child.fn);
      else if (site?.remote) add(`requests from ${node.fn}`, child.fn);
      walk(child);
    }
  };
  walk(tree.root);
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const group of groups.values()) {
    const list = [...group].sort();
    const key = list.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(list);
  }
  // A function that is its own group makes any larger group holding it redundant.
  const singles = new Set(result.filter((g) => g.length === 1).map((g) => g[0]!));
  return result.filter((g) => g.length === 1 || !g.some((fn) => singles.has(fn)));
}

/** Every function under the nodes for `fns` (the nodes themselves included). */
export function subtreeFunctions(tree: CallTree, fns: Iterable<string>): Set<string> {
  const wanted = new Set(fns);
  const found = new Set<string>();
  const collect = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    found.add(node.fn);
    node.children.forEach(collect);
  };
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    if (wanted.has(node.fn)) collect(node);
    else node.children.forEach(walk);
  };
  walk(tree.root);
  return found;
}

/** The expanded node of each function (the first one with children, else the first seen). */
export function nodesFor(tree: CallTree, fns: Iterable<string>): FunctionTreeNode[] {
  const wanted = new Set(fns);
  const best = new Map<string, FunctionTreeNode>();
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    if (wanted.has(node.fn)) {
      const current = best.get(node.fn);
      if (!current || (current.children.length === 0 && node.children.length > 0)) best.set(node.fn, node);
    }
    node.children.forEach(walk);
  };
  walk(tree.root);
  return [...wanted].flatMap((fn) => (best.has(fn) ? [best.get(fn)!] : []));
}
