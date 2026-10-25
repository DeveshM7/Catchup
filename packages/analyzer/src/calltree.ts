import type { CallFact, EntryPointFact, Facts } from "./facts.js";
import { externalFor } from "./externals.js";

export type Importance = "important" | "normal" | "noise";

export type CallSite = {
  line: number;
  conditional?: true;
  parallel?: true;
  onError?: true;
  oneOf?: true;
  passed?: true;
  tool?: true;
  render?: true;
  /** UI event the callee handles (`onSubmit`). */
  event?: string;
  /** Entry point id when this is a request from client code to our route. */
  remote?: string;
  /** Message type when the server sends this function a message (`data-textDelta`). */
  message?: string;
};

export type FunctionTreeNode = {
  kind: "function";
  fn: string;
  component: string;
  site?: CallSite;
  children: TreeNode[];
  /**
   * Why the node wasn't expanded: on the current path, already expanded earlier in this tree, a limit, or
   * a UI event handler (a separate user action with its own `ui:` entry point), or a client function that handles a
   * streamed message (the journey ends where the browser receives it; expanding a handler that is a whole component
   * would pull in everything that component does).
   */
  stop?: "cycle" | "repeat" | "depth" | "size" | "event" | "message";
  importance: Importance;
};

export type ExternalTreeNode = {
  kind: "external";
  package: string;
  system?: string;
  callee: string;
  site: CallSite;
  /** Callee name looks like a write (create, update, set, publish, …). */
  writes?: true;
  importance: Importance;
};

export type DynamicTreeNode = { kind: "dynamic"; callee: string; site: CallSite; importance: Importance };

/** Runs a function value whose steps are shown where it is defined (caller's argument, returned closure). */
export type CallbackTreeNode = { kind: "callback"; callee: string; site: CallSite; importance: Importance };

export type TreeNode = FunctionTreeNode | ExternalTreeNode | DynamicTreeNode | CallbackTreeNode;

export type CallTree = {
  entryPoint: EntryPointFact;
  root: FunctionTreeNode;
  /** True when some call target is only known at runtime; `dynamicCalls` says where. */
  partial: boolean;
  dynamicCalls: { fn: string; line: number; callee: string }[];
  functionCount: number;
  systems: string[];
};

export type TreeLimits = { maxDepth: number; maxFunctions: number };
export const DEFAULT_TREE_LIMITS: TreeLimits = { maxDepth: 12, maxFunctions: 300 };

const WRITE_CALLEE =
  /(^|\.)(create(?!Client|Pool|Connection)|insert|update|upsert|delete|remove|save|set|del|incr|decr|push|publish|send|produce|write|executeRaw)\w*$/i;

function siteOf(call: CallFact): CallSite {
  return {
    line: call.line,
    ...(call.conditional ? { conditional: true as const } : {}),
    ...(call.parallel ? { parallel: true as const } : {}),
    ...(call.onError ? { onError: true as const } : {}),
    ...(call.oneOf ? { oneOf: true as const } : {}),
    ...(call.passed ? { passed: true as const } : {}),
    ...(call.tool ? { tool: true as const } : {}),
    ...(call.render ? { render: true as const } : {}),
    ...(call.event ? { event: call.event } : {}),
    ...(call.remote ? { remote: call.remote } : {}),
    ...(call.message ? { message: call.message } : {}),
  };
}

export function callsByCaller(calls: CallFact[]): Map<string, CallFact[]> {
  const byFrom = new Map<string, CallFact[]>();
  for (const call of calls) byFrom.set(call.from, [...(byFrom.get(call.from) ?? []), call]);
  return byFrom;
}

/** Deterministic call tree for one entry point, computed from facts only (no compiler needed). */
export function buildCallTree(
  facts: Pick<Facts, "calls">,
  entryPoint: EntryPointFact,
  componentOf: (file: string) => string,
  limits: TreeLimits = DEFAULT_TREE_LIMITS,
  byCaller: Map<string, CallFact[]> = callsByCaller(facts.calls),
): CallTree {
  const expanded = new Set<string>();
  const onPath = new Set<string>();
  const dynamicCalls: CallTree["dynamicCalls"] = [];
  const systems = new Set<string>();
  let functionCount = 0;

  const fileOf = (fn: string): string => fn.slice(0, fn.indexOf("#"));

  const expand = (fn: string, depth: number, site?: CallSite): FunctionTreeNode => {
    const node: FunctionTreeNode = {
      kind: "function",
      fn,
      component: componentOf(fileOf(fn)),
      ...(site ? { site } : {}),
      children: [],
      importance: "normal",
    };
    if (onPath.has(fn)) return { ...node, stop: "cycle" };
    if (site?.event) return { ...node, stop: "event" };
    if (site?.message) return { ...node, stop: "message" };
    if (expanded.has(fn)) return { ...node, stop: "repeat" };
    if (depth >= limits.maxDepth) return { ...node, stop: "depth" };
    if (functionCount >= limits.maxFunctions) return { ...node, stop: "size" };
    functionCount += 1;
    expanded.add(fn);
    onPath.add(fn);
    for (const call of byCaller.get(fn) ?? []) {
      const callSite = siteOf(call);
      if (call.kind === "direct" && call.to !== null) {
        node.children.push(expand(call.to, depth + 1, callSite));
      } else if (call.kind === "external" && call.target !== undefined) {
        const system = externalFor(call.target)?.name;
        if (system) systems.add(system);
        node.children.push({
          kind: "external",
          package: call.target,
          ...(system ? { system } : {}),
          callee: call.callee,
          site: callSite,
          ...(system && WRITE_CALLEE.test(call.callee) ? { writes: true as const } : {}),
          importance: "normal",
        });
      } else if (call.kind === "callback") {
        node.children.push({ kind: "callback", callee: call.callee, site: callSite, importance: "normal" });
      } else {
        dynamicCalls.push({ fn, line: call.line, callee: call.callee });
        node.children.push({ kind: "dynamic", callee: call.callee, site: callSite, importance: "normal" });
      }
    }
    onPath.delete(fn);
    return node;
  };

  const root = expand(entryPoint.handler, 0);
  return {
    entryPoint,
    root,
    partial: dynamicCalls.length > 0,
    dynamicCalls,
    functionCount,
    systems: [...systems].sort(),
  };
}
