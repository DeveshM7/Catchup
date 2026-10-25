import { createHash } from "node:crypto";
import type { CallTree, Facts, FunctionFact, Snapshot } from "@catchup/analyzer";
import { componentIndex } from "@catchup/analyzer";
import { importantFunctions, renderSnippets, renderTree, treeFunctions, type BriefInputs } from "./brief.js";
import { mergeSteps, planFlow } from "./carry.js";
import { askStructured, type Runner } from "./droid.js";
import { areasPrompt, flowPrompt, labelsPrompt, type ComponentBrief, type FlowSummary } from "./prompts.js";
import { explainOverview, mainFlows, readmeExcerpt } from "./overview.js";
import { componentsOf } from "./rank.js";
import { AreasOutput, FlowOutput, LabelsOutput, type Area, type ComponentLabel, type Explained, type Flow } from "./schemas.js";
import { validateAreas, validateFlow, validateLabels } from "./validate.js";

export type ExplainInputs = {
  facts: Facts;
  snapshot: Snapshot;
  /** Scored trees for the flows to explain. */
  trees: CallTree[];
  /** Every entry point's tree; when given, the first screen is written from the main flows (D34). */
  allTrees?: CallTree[];
  previous?: Explained;
  runner: Runner;
  model: string;
  readFile: BriefInputs["readFile"];
  concurrency?: number;
  onCall?: (job: string, attempt: number) => void;
  onRejected?: (job: string, problems: string[]) => void;
};

export type ExplainStats = {
  claudeJobs: number;
  carriedFlows: number;
  updatedFlows: number;
  newFlows: number;
  carriedLabels: number;
  carriedOverview: boolean;
};

function packageLine(readFile: BriefInputs["readFile"]): string {
  try {
    const pkg = JSON.parse(readFile("package.json") ?? "{}") as { name?: unknown; description?: unknown };
    return [pkg.name, pkg.description].filter((v): v is string => typeof v === "string" && v.length > 0).join(" — ");
  } catch {
    return "";
  }
}

function basisOf(tree: CallTree, functions: Map<string, FunctionFact>): Record<string, string> {
  const basis: Record<string, string> = {};
  for (const id of [...treeFunctions(tree)].sort()) basis[id] = functions.get(id)?.hash ?? "";
  return basis;
}

const fileBasis = (files: string[]): string => createHash("sha256").update([...files].sort().join("\n")).digest("hex").slice(0, 16);

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return results;
}

async function explainFlow(tree: CallTree, inputs: ExplainInputs, functions: Map<string, FunctionFact>): Promise<{ flow: Flow; mode: string }> {
  const basis = basisOf(tree, functions);
  const previous = inputs.previous?.flows.find((f) => f.id === tree.entryPoint.id);
  const plan = planFlow(previous, basis);
  if (plan.mode === "carry") return { flow: { ...plan.flow, label: tree.entryPoint.label, partial: tree.partial }, mode: "carry" };
  const brief: BriefInputs = { functions, readFile: inputs.readFile };
  const keepIds = plan.mode === "update" ? plan.keepIds : new Set<string>();
  const output = await askStructured({
    job: `flow ${tree.entryPoint.label}`,
    prompt: flowPrompt(tree, renderTree(tree, brief), renderSnippets(tree, brief), plan),
    schema: FlowOutput,
    check: (value) =>
      validateFlow(value, {
        allowed: treeFunctions(tree),
        mustCover: importantFunctions(tree),
        previousIds: new Set(previous?.steps.map((s) => s.id) ?? []),
        keepIds,
      }),
    runner: inputs.runner,
    onCall: inputs.onCall,
    onRejected: inputs.onRejected,
  });
  const steps = mergeSteps(tree.entryPoint.id, output, previous, keepIds);
  return { flow: { id: tree.entryPoint.id, label: tree.entryPoint.label, steps, partial: tree.partial, basis }, mode: plan.mode };
}

async function labelComponents(inputs: ExplainInputs): Promise<{ labels: ComponentLabel[]; carried: number }> {
  const before = new Map((inputs.previous?.components ?? []).map((c) => [c.id, c]));
  const carried: ComponentLabel[] = [];
  const todo: ComponentBrief[] = [];
  const byComponent = componentIndex(inputs.snapshot);
  for (const component of inputs.snapshot.components) {
    const basis = fileBasis(component.files);
    const old = before.get(component.id);
    if (old && old.basis === basis) {
      carried.push(old);
      continue;
    }
    todo.push({
      component,
      functions: inputs.facts.functions.filter((f) => byComponent.get(f.file) === component.id),
      systems: inputs.snapshot.externals.filter((e) => e.usedBy.includes(component.id)).map((e) => e.name),
    });
  }
  if (todo.length === 0) return { labels: carried, carried: carried.length };
  const expected = todo.map((t) => t.component.id);
  const output = await askStructured({
    job: "component labels",
    prompt: labelsPrompt(todo),
    schema: LabelsOutput,
    check: (value) => validateLabels(value, expected),
    runner: inputs.runner,
    onCall: inputs.onCall,
    onRejected: inputs.onRejected,
  });
  const fresh = output.labels.map((l) => {
    const component = todo.find((t) => t.component.id === l.id)?.component;
    return { id: l.id, name: l.name, description: l.description, basis: fileBasis(component?.files ?? []) };
  });
  const labels = [...carried, ...fresh].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { labels, carried: carried.length };
}

async function groupAreas(flows: Flow[], trees: Map<string, CallTree>, inputs: ExplainInputs): Promise<Area[]> {
  const flowIds = flows.map((f) => f.id);
  const previous = inputs.previous?.areas ?? [];
  const previousIds = previous.flatMap((a) => a.flows).sort();
  if (previous.length > 0 && JSON.stringify(previousIds) === JSON.stringify([...flowIds].sort())) return previous;
  const summaries: FlowSummary[] = flows.map((f) => {
    const tree = trees.get(f.id);
    return { id: f.id, label: f.label, steps: f.steps.map((s) => s.label), systems: tree?.systems ?? [], components: tree ? componentsOf(tree) : [] };
  });
  const output = await askStructured({
    job: "areas",
    prompt: areasPrompt(summaries, previous),
    schema: AreasOutput,
    check: (value) => validateAreas(value, flowIds),
    runner: inputs.runner,
    onCall: inputs.onCall,
    onRejected: inputs.onRejected,
  });
  return output.areas.map((a) => ({ ...a, flows: flowIds.filter((id) => a.flows.includes(id)) }));
}

/**
 * Explains a snapshot as an edit of the previous explanation (ARCHITECTURE §6): unchanged flows and
 * labels are copied without a Claude call; every Claude answer is validated against the facts.
 */
export async function explainSnapshot(inputs: ExplainInputs): Promise<{ explained: Explained; stats: ExplainStats }> {
  const functions = new Map(inputs.facts.functions.map((f) => [f.id, f]));
  let jobs = 0;
  const onCall = (job: string, attempt: number): void => {
    jobs += 1;
    inputs.onCall?.(job, attempt);
  };
  const withCount: ExplainInputs = { ...inputs, onCall };
  const { labels, carried } = await labelComponents(withCount);
  const results = await inBatches(inputs.trees, inputs.concurrency ?? 4, (tree) => explainFlow(tree, withCount, functions));
  const flows = results.map((r) => r.flow).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const trees = new Map(inputs.trees.map((t) => [t.entryPoint.id, t]));
  const areas = await groupAreas(flows, trees, withCount);
  const { overview, carried: carriedOverview } = inputs.allTrees
    ? await explainOverview({
        inputs: {
          flows: mainFlows(inputs.allTrees),
          brief: { functions, readFile: inputs.readFile },
          packageLine: packageLine(inputs.readFile),
          readme: readmeExcerpt(inputs.readFile("README.md")),
        },
        previous: inputs.previous?.overview,
        runner: inputs.runner,
        onCall,
        onRejected: inputs.onRejected,
      })
    : { overview: inputs.previous?.overview, carried: true };
  const count = (mode: string): number => results.filter((r) => r.mode === mode).length;
  return {
    explained: { sha: inputs.facts.sha, model: inputs.model, components: labels, flows, areas, ...(overview ? { overview } : {}) },
    stats: {
      claudeJobs: jobs,
      carriedFlows: count("carry"),
      updatedFlows: count("update"),
      newFlows: count("new"),
      carriedLabels: carried,
      carriedOverview,
    },
  };
}
