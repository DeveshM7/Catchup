import type { CallTree, TreeNode } from "./calltree.js";
import { externalFor } from "./externals.js";
import type { Facts, Side } from "./facts.js";
import { PKG_PREFIX } from "./facts.js";
import { flowFamilies, type FlowFamily } from "./families.js";
import { MODULE_UNIT } from "./functions.js";
import { compareStrings } from "./sort.js";

/** Per function: what ranks it for a reader (ARCHITECTURE §4). Signals rank; they never hide anything. */
export type FunctionSignals = {
  /** Entry-point trees that reach it. */
  flows: number;
  /** Outside systems it calls directly. */
  systems: string[];
  /** Distinct functions that call it. */
  fanIn: number;
  exported: boolean;
  loc: number;
  side?: Side;
  /** Its name appears in the README. */
  readme: boolean;
};

export type FileSignals = {
  flows: number;
  systems: string[];
  /** Distinct files that import it. */
  fanIn: number;
  /** Commits that touched it (up to the analyzed commit). */
  churn: number;
  /** ISO date of the last commit that touched it. */
  lastChanged?: string;
  /** Its path or file name appears in the README. */
  readme: boolean;
  /** Exports at least one function. */
  exported: boolean;
  loc: number;
  side?: Side;
};

export type Signals = {
  sha: string;
  functions: Record<string, FunctionSignals>;
  files: Record<string, FileSignals>;
  families: FlowFamily[];
};

export type SignalInputs = {
  facts: Facts;
  trees: CallTree[];
  /** file → commits and last change, from git; missing files count as 0. */
  churn?: Map<string, { commits: number; lastChanged: string }>;
  readme?: string;
};

/** Names shorter than this (`get`, `run`) match too much prose to count as README mentions. */
const MIN_README_NAME = 4;

function fileOf(fn: string): string {
  return fn.slice(0, fn.indexOf("#"));
}

function functionsIn(tree: CallTree): Set<string> {
  const found = new Set<string>();
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    found.add(node.fn);
    node.children.forEach(walk);
  };
  walk(tree.root);
  return found;
}

function mentions(readme: string | undefined): (word: string) => boolean {
  if (!readme) return () => false;
  const words = new Set(readme.match(/[\w$./-]+/g) ?? []);
  const bare = new Set([...words].map((w) => w.replace(/[./-]+$/, "")));
  return (word) => bare.has(word) || words.has(word);
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareStrings);

/** Deterministic signals per function and file, plus flow families (Build 1). */
export function computeSignals(inputs: SignalInputs): Signals {
  const { facts, trees } = inputs;
  const mentioned = mentions(inputs.readme);
  const sideOf = new Map(facts.files.map((f) => [f.path, f.side]));

  const flowsOf = new Map<string, number>();
  const fileFlows = new Map<string, number>();
  for (const tree of trees) {
    const fns = functionsIn(tree);
    for (const fn of fns) flowsOf.set(fn, (flowsOf.get(fn) ?? 0) + 1);
    for (const file of new Set([...fns].map(fileOf))) fileFlows.set(file, (fileFlows.get(file) ?? 0) + 1);
  }

  const callers = new Map<string, Set<string>>();
  const systemsOf = new Map<string, string[]>();
  for (const call of facts.calls) {
    if (call.kind === "direct" && call.to !== null && call.to !== call.from) callers.set(call.to, (callers.get(call.to) ?? new Set()).add(call.from));
    const system = call.kind === "external" && call.target !== undefined ? externalFor(call.target)?.name : undefined;
    if (system) systemsOf.set(call.from, [...(systemsOf.get(call.from) ?? []), system]);
  }

  const functions: Record<string, FunctionSignals> = {};
  for (const fn of facts.functions) {
    const side = sideOf.get(fn.file);
    const name = fn.name.slice(fn.name.lastIndexOf(".") + 1).replace(/~\d+$/, "");
    functions[fn.id] = {
      flows: flowsOf.get(fn.id) ?? 0,
      systems: sorted(systemsOf.get(fn.id) ?? []),
      fanIn: callers.get(fn.id)?.size ?? 0,
      exported: fn.exported === true,
      loc: fn.endLine - fn.startLine + 1,
      ...(side ? { side } : {}),
      readme: name !== MODULE_UNIT && name.length >= MIN_README_NAME && mentioned(name),
    };
  }

  const importers = new Map<string, Set<string>>();
  for (const { from, to } of facts.imports) if (!to.startsWith(PKG_PREFIX) && to !== from) importers.set(to, (importers.get(to) ?? new Set()).add(from));
  const fnsByFile = new Map<string, string[]>();
  for (const fn of facts.functions) fnsByFile.set(fn.file, [...(fnsByFile.get(fn.file) ?? []), fn.id]);

  const files: Record<string, FileSignals> = {};
  for (const file of facts.files) {
    const ids = fnsByFile.get(file.path) ?? [];
    const churn = inputs.churn?.get(file.path);
    const base = file.path.slice(file.path.lastIndexOf("/") + 1);
    files[file.path] = {
      flows: fileFlows.get(file.path) ?? 0,
      systems: sorted(ids.flatMap((id) => functions[id]?.systems ?? [])),
      fanIn: importers.get(file.path)?.size ?? 0,
      churn: churn?.commits ?? 0,
      ...(churn ? { lastChanged: churn.lastChanged } : {}),
      readme: mentioned(file.path) || (base.includes(".") && mentioned(base)),
      exported: ids.some((id) => functions[id]?.exported),
      loc: file.loc,
      ...(file.side ? { side: file.side } : {}),
    };
  }

  return { sha: facts.sha, functions, files, families: flowFamilies(trees) };
}
