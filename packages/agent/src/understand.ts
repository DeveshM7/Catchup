import type { CallTree, Facts, Signals, Snapshot } from "@catchup/analyzer";
import type * as z from "zod/v4";
import { treeFunctions, type BriefInputs } from "./brief.js";
import { askStructured, type Runner } from "./droid.js";
import { keyFunctionGroups, nodesFor, preorder, subtreeFunctions } from "./journey.js";
import {
  ChildrenOutput,
  ExtrasOutput,
  fileOf,
  hashOf,
  journeyId,
  partId,
  sortedNodes,
  StepsOutput,
  stepId,
  SurveyOutput,
  systemId,
  type Extras,
  type OtherFlow,
  type Understanding,
  type UnderstandingNode,
} from "./tree.js";
import { assignFiles, checkCount, checkSteps, checkWords, type StepRules } from "./treecheck.js";
import { childrenPrompt, extrasPrompt, OTHER_FLOWS, stepsPrompt, subStepsPrompt, surveyPrompt, type PromptContext } from "./understandPrompts.js";

/** Nodes with fewer files or functions than this are leaves (ARCHITECTURE §7). */
export const MIN_TO_SPLIT = 3;
/** Claude-written levels. */
export const MAX_DEPTH = 5;
const DEFAULT_CONCURRENCY = 4;

export type UnderstandInputs = {
  facts: Facts;
  snapshot: Snapshot;
  signals: Signals;
  trees: CallTree[];
  /** Digest file name → markdown (already written to `digestDir`). */
  digest: Record<string, string>;
  digestDir: string;
  maxToolCalls: number;
  readFile: (path: string) => string | undefined;
  model: string;
  /** The stored tree for this commit, if any: unchanged passes are copied from it. */
  previous?: Understanding;
  /** A runner per pass; the name goes into the run log. */
  runnerFor: (pass: string) => Runner;
  concurrency?: number;
  onCall?: (job: string, attempt: number) => void;
  onRejected?: (job: string, problems: string[]) => void;
  /** Called with each validated stage, so a later failure doesn't lose finished passes. */
  onProgress?: (partial: Understanding) => void;
};

export type UnderstandStats = { calls: number; passes: number; carried: number };

type Work = {
  inputs: UnderstandInputs;
  ctx: PromptContext;
  nodes: Record<string, UnderstandingNode>;
  taken: Set<string>;
  stats: UnderstandStats;
  trees: Map<string, CallTree>;
  allFiles: string[];
  allFunctions: Set<string>;
};

function startWork(inputs: UnderstandInputs, nodes: Record<string, UnderstandingNode> = {}): Work {
  const brief: BriefInputs = { functions: new Map(inputs.facts.functions.map((fn) => [fn.id, fn])), readFile: inputs.readFile };
  return {
    inputs,
    ctx: { facts: inputs.facts, signals: inputs.signals, digest: inputs.digest, digestDir: inputs.digestDir, maxToolCalls: inputs.maxToolCalls, brief },
    nodes: { ...nodes },
    taken: new Set(Object.keys(nodes)),
    stats: { calls: 0, passes: 0, carried: 0 },
    trees: new Map(inputs.trees.map((t) => [t.entryPoint.id, t])),
    allFiles: inputs.facts.files.map((f) => f.path),
    allFunctions: new Set(inputs.facts.functions.map((f) => f.id)),
  };
}

function ask<T>(work: Work, pass: string, prompt: string, schema: z.ZodType<T>, check: (value: T) => string[]): Promise<T> {
  work.stats.passes += 1;
  return askStructured({
    job: pass,
    prompt,
    schema,
    check,
    runner: work.inputs.runnerFor(pass),
    onCall: (job, attempt) => {
      work.stats.calls += 1;
      work.inputs.onCall?.(job, attempt);
    },
    onRejected: work.inputs.onRejected,
  });
}

async function pool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]!();
  });
  await Promise.all(workers);
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function centralFile(work: Work): (files: string[]) => string {
  const signals = work.inputs.signals.files;
  return (files) =>
    [...files].sort((a, b) => {
      const x = signals[a];
      const y = signals[b];
      return (y?.flows ?? 0) - (x?.flows ?? 0) || (y?.fanIn ?? 0) - (x?.fanIn ?? 0) || (a < b ? -1 : 1);
    })[0]!;
}

function topPartOf(work: Work, partIds: string[]): (file: string) => string | undefined {
  const index = new Map<string, string>();
  for (const id of partIds) for (const file of work.nodes[id]?.anchor.files ?? []) index.set(file, id);
  return (file) => index.get(file);
}

function systemsOfFunctions(work: Work, functions: string[]): string[] {
  return sorted(functions.flatMap((fn) => work.inputs.signals.functions[fn]?.systems ?? []));
}

/** A family id as Claude wrote it, without heading decoration (`Family 2: \`id\``). */
const familyKey = (raw: string): string => raw.trim().replace(/^family\s+\d+\s*:\s*/i, "").replace(/^`+|`+$/g, "").trim();

/** Families (best first) that hold none of the journeys: the ones that get a line. */
function otherFamilies(work: Work, entries: string[]): Signals["families"] {
  return work.inputs.signals.families.filter((f) => !f.members.some((m) => entries.includes(m))).slice(0, OTHER_FLOWS);
}

// ---------- Survey ----------

function checkSurvey(work: Work, out: SurveyOutput): string[] {
  const problems = checkWords("summary", { summary: out.summary });
  problems.push(...checkCount("parts", out.parts.length, Math.min(2, work.allFiles.length), 7));
  out.parts.forEach((p, i) => problems.push(...checkWords(`part ${i + 1} ("${p.title}")`, { title: p.title, short: p.short, long: p.long })));
  problems.push(...assignFiles(out.parts, work.allFiles).problems);

  problems.push(...checkCount("journeys", out.journeys.length, 1, 3));
  const entries = new Set<string>();
  for (const j of out.journeys) {
    const tree = work.trees.get(j.entry);
    if (!tree) problems.push(`journey "${j.title}": "${j.entry}" is not an entry point id from entries.md`);
    else if (tree.entryPoint.kind === "page") problems.push(`journey "${j.title}": "${j.entry}" is a page (a screen), not something a user does`);
    else if (tree.functionCount < MIN_TO_SPLIT) {
      problems.push(`journey "${j.title}": "${j.entry}" runs only ${tree.functionCount} function(s), too little to tell as steps; give it a line in otherFlows instead`);
    }
    if (entries.has(j.entry)) problems.push(`journey entry "${j.entry}" is used twice`);
    entries.add(j.entry);
    problems.push(...checkWords(`journey "${j.title}"`, { title: j.title, short: j.short, long: j.long }));
  }
  // Entry points in one flow family run mostly the same code: two of them would tell one story twice (D54).
  const familyOf = new Map(work.inputs.signals.families.flatMap((f) => f.members.map((m) => [m, f.id] as const)));
  const firstIn = new Map<string, string>();
  for (const j of out.journeys) {
    const family = familyOf.get(j.entry);
    if (family === undefined) continue;
    const other = firstIn.get(family);
    if (other !== undefined) problems.push(`journeys "${other}" and "${j.title}" run mostly the same code (both in family ${family}); pick each journey from a different family`);
    else firstIn.set(family, j.title);
  }

  const wanted = otherFamilies(work, [...entries]).map((f) => f.id);
  const given = new Set<string>();
  for (const raw of out.otherFlows) {
    const flow = { ...raw, family: familyKey(raw.family) };
    if (!wanted.includes(flow.family)) problems.push(`otherFlows: "${flow.family}" is not one of the families to describe`);
    if (given.has(flow.family)) problems.push(`otherFlows: family "${flow.family}" is described twice`);
    given.add(flow.family);
    problems.push(...checkWords(`otherFlows "${flow.family}"`, { line: flow.line }));
  }
  const missing = wanted.filter((id) => !given.has(id));
  if (missing.length) problems.push(`otherFlows is missing these families: ${missing.join(", ")}`);
  return problems;
}

function journeyNode(work: Work, entry: string, text: { title: string; short: string; long: string }, partIds: string[], basis: string): UnderstandingNode {
  const tree = work.trees.get(entry)!;
  const functions = sorted(treeFunctions(tree));
  const files = sorted(functions.map(fileOf));
  const partOf = topPartOf(work, partIds);
  return {
    id: journeyId(entry),
    kind: "journey",
    ...text,
    anchor: { files, functions },
    entry,
    parts: sorted(files.flatMap((f) => partOf(f) ?? [])),
    systems: [...tree.systems],
    children: "unopened",
    depth: 1,
    basis,
  };
}

type SurveyResult = { summary: string; parts: string[]; journeys: string[]; otherFlows: OtherFlow[] };

function buildSurvey(work: Work, out: SurveyOutput, basis: string): SurveyResult {
  const { files } = assignFiles(out.parts, work.allFiles);
  const central = centralFile(work);
  const parts = out.parts.map((p, i) => {
    const anchorFiles = sorted(files[i]!);
    const id = partId(anchorFiles, work.taken, central);
    work.nodes[id] = {
      id,
      kind: "part",
      title: p.title,
      short: p.short,
      long: p.long,
      anchor: { files: anchorFiles, functions: [] },
      children: anchorFiles.length < MIN_TO_SPLIT ? "leaf" : "unopened",
      depth: 1,
      basis,
    };
    return id;
  });
  const journeys = out.journeys.map((j) => {
    const node = journeyNode(work, j.entry, { title: j.title, short: j.short, long: j.long }, parts, basis);
    work.nodes[node.id] = node;
    work.taken.add(node.id);
    return node.id;
  });
  const lines = new Map(out.otherFlows.map((f) => [familyKey(f.family), f.line]));
  const otherFlows = otherFamilies(work, out.journeys.map((j) => j.entry)).map((family): OtherFlow => ({
    family: family.id,
    entry: family.representative,
    label: work.trees.get(family.representative)?.entryPoint.label ?? family.representative,
    members: family.members.length,
    line: lines.get(family.id) ?? "",
  }));
  return { summary: out.summary, parts, journeys, otherFlows };
}

// ---------- Parts ----------

function checkChildren(node: UnderstandingNode, out: ChildrenOutput): string[] {
  if (out.leaf) return [];
  const problems = checkCount("children", out.children.length, 2, 7);
  out.children.forEach((c, i) => problems.push(...checkWords(`child ${i + 1} ("${c.title}")`, { title: c.title, short: c.short, long: c.long })));
  problems.push(...assignFiles(out.children, node.anchor.files).problems);
  return problems;
}

function buildChildren(work: Work, parent: UnderstandingNode, out: ChildrenOutput, basis: string): void {
  parent.childrenBasis = basis;
  if (out.leaf) {
    parent.children = "leaf";
    return;
  }
  const { files } = assignFiles(out.children, parent.anchor.files);
  const central = centralFile(work);
  parent.children = out.children.map((c, i) => {
    const anchorFiles = sorted(files[i]!);
    const id = partId(anchorFiles, work.taken, central);
    const depth = parent.depth + 1;
    work.nodes[id] = {
      id,
      kind: "part",
      title: c.title,
      short: c.short,
      long: c.long,
      anchor: { files: anchorFiles, functions: [] },
      children: anchorFiles.length < MIN_TO_SPLIT || depth >= MAX_DEPTH ? "leaf" : "unopened",
      depth,
      basis,
    };
    return id;
  });
}

// ---------- Steps ----------

function journeyRules(tree: CallTree): StepRules {
  return { allowed: treeFunctions(tree), order: preorder(tree), first: tree.root.fn, mustCover: keyFunctionGroups(tree), min: 3, max: 7 };
}

function subStepRules(tree: CallTree, step: UnderstandingNode): StepRules {
  return { allowed: subtreeFunctions(tree, step.anchor.functions), order: preorder(tree), mustCover: step.anchor.functions.map((fn) => [fn]), min: 2, max: 7 };
}

function buildSteps(work: Work, parent: UnderstandingNode, tree: CallTree, out: StepsOutput, basis: string): void {
  const partOf = topPartOf(work, topPartIds(work));
  parent.childrenBasis = basis;
  parent.children = out.steps.map((s) => {
    const functions = [...new Set(s.functions)];
    const files = sorted(functions.map(fileOf));
    const id = stepId(parent.id, functions, work.taken);
    const depth = parent.depth + 1;
    const big = subtreeFunctions(tree, functions).size >= MIN_TO_SPLIT;
    work.nodes[id] = {
      id,
      kind: "step",
      title: s.title,
      short: s.short,
      long: s.long,
      anchor: { files, functions },
      parts: sorted(files.flatMap((f) => partOf(f) ?? [])),
      systems: systemsOfFunctions(work, functions),
      stepKind: s.kind,
      children: s.open && big && depth < MAX_DEPTH ? "unopened" : "leaf",
      depth,
      basis,
    };
    return id;
  });
}

function topPartIds(work: Work): string[] {
  return Object.values(work.nodes)
    .filter((n) => n.kind === "part" && n.depth === 1)
    .map((n) => n.id);
}

function journeyOf(work: Work, node: UnderstandingNode): { journey: UnderstandingNode; tree: CallTree } {
  // Entry ids hold "#" too, so find the journey whose id prefixes the step's.
  const journey = Object.values(work.nodes).find((n) => n.kind === "journey" && node.id.startsWith(`${n.id}#`));
  const tree = journey?.entry !== undefined ? work.trees.get(journey.entry) : undefined;
  if (!journey || !tree) throw new Error(`no journey for step ${node.id}`);
  return { journey, tree };
}

// ---------- Carry forward ----------

/** Copies a node's descendants from the previous tree. */
function copyDescendants(work: Work, previous: Understanding, id: string): void {
  const node = previous.nodes[id];
  if (!node || !Array.isArray(node.children)) return;
  for (const child of node.children) {
    const copy = previous.nodes[child];
    if (!copy) continue;
    work.nodes[child] = copy;
    work.taken.add(child);
    copyDescendants(work, previous, child);
  }
}

/** True (and copied) when the node's children were written from the same prompt before. */
function carryChildren(work: Work, node: UnderstandingNode, basis: string): boolean {
  const before = work.inputs.previous?.nodes[node.id];
  if (!before || before.childrenBasis !== basis) return false;
  node.children = before.children;
  node.childrenBasis = basis;
  copyDescendants(work, work.inputs.previous!, node.id);
  work.stats.carried += 1;
  return true;
}

// ---------- Extras ----------

function checkExtras(work: Work, out: ExtrasOutput): string[] {
  const files = new Set(work.allFiles);
  const problems = [
    ...checkCount("glossary entries", out.glossary.length, 3, 8),
    ...checkCount("startHere files", out.startHere.length, 2, 4),
    ...checkCount("changes", out.changes.length, 3, 6),
    ...checkCount("surprises", out.surprises.length, 0, 5),
  ];
  const checkCites = (where: string, cites: string[]): void => {
    if (cites.length === 0) problems.push(`${where} cites nothing`);
    for (const c of cites) if (!files.has(c) && !work.allFunctions.has(c)) problems.push(`${where} cites "${c}", which is not a file path or function ID`);
  };
  out.glossary.forEach((g) => {
    checkCites(`glossary "${g.term}"`, g.cites);
    problems.push(...checkWords(`glossary "${g.term}"`, { title: g.term, meaning: g.meaning }));
  });
  out.startHere.forEach((s) => {
    if (!files.has(s.file)) problems.push(`startHere "${s.file}" is not a source file`);
    problems.push(...checkWords(`startHere "${s.file}"`, { why: s.why }));
  });
  out.changes.forEach((c) => {
    checkCites(`change "${c.task}"`, c.cites);
    problems.push(...checkWords(`change "${c.task}"`, { task: c.task }));
  });
  out.surprises.forEach((s, i) => {
    checkCites(`surprise ${i + 1}`, s.cites);
    problems.push(...checkWords(`surprise ${i + 1}`, { surprise: s.text }));
  });
  return problems;
}

function buildExtras(work: Work, out: ExtrasOutput, basis: string): Extras {
  const split = (cites: string[]): { files: string[]; functions: string[] } => ({
    files: cites.filter((c) => !work.allFunctions.has(c)),
    functions: cites.filter((c) => work.allFunctions.has(c)),
  });
  return {
    glossary: out.glossary.map((g) => ({ term: g.term, meaning: g.meaning, ...split(g.cites) })),
    startHere: out.startHere.map((s) => ({ file: s.file, why: s.why })),
    changes: out.changes.map((c) => ({ task: c.task, ...split(c.cites) })),
    surprises: out.surprises.map((s) => ({ text: s.text, ...split(s.cites) })),
    basis,
  };
}

// ---------- Passes ----------

function systemNodes(work: Work): string[] {
  return work.inputs.snapshot.externals.map((ext) => {
    const id = systemId(ext.name);
    const files = sorted(Object.entries(work.inputs.signals.files).flatMap(([path, s]) => (s.systems.includes(ext.name) ? [path] : [])));
    work.nodes[id] = {
      id,
      kind: "system",
      title: ext.name,
      short: `${ext.kind === "tool" ? "Outside tool" : "Outside system"}, through ${ext.packages.join(", ")}`,
      long: `Called directly from ${files.length} file${files.length === 1 ? "" : "s"}.`,
      anchor: { files, functions: [] },
      children: "leaf",
      depth: 0,
      basis: "code",
    };
    work.taken.add(id);
    return id;
  });
}

function snapshotOf(work: Work, survey: SurveyResult, systems: string[], basis: string, extras?: Extras): Understanding {
  return {
    sha: work.inputs.facts.sha,
    model: work.inputs.model,
    summary: survey.summary,
    parts: survey.parts,
    journeys: survey.journeys,
    systems,
    otherFlows: survey.otherFlows,
    nodes: sortedNodes(work.nodes),
    ...(extras ? { extras } : {}),
    basis,
  };
}

/**
 * Builds the understanding tree (ARCHITECTURE §6): Survey, then Parts and Journeys in parallel, then Extras.
 * A pass whose prompt is unchanged since the stored tree is copied without a Claude call (D4, D38).
 */
export async function understand(inputs: UnderstandInputs): Promise<{ understanding: Understanding; stats: UnderstandStats }> {
  const work = startWork(inputs);
  const previous = inputs.previous;
  const systems = systemNodes(work);

  const surveyText = surveyPrompt(work.ctx);
  const basis = hashOf(surveyText);
  let survey: SurveyResult;
  if (previous && previous.basis === basis) {
    survey = { summary: previous.summary, parts: previous.parts, journeys: previous.journeys, otherFlows: previous.otherFlows };
    for (const id of [...survey.parts, ...survey.journeys]) {
      const node = previous.nodes[id];
      if (!node) throw new Error(`stored tree is missing node ${id}`);
      // Children come back below if their own pass is unchanged too.
      const { childrenBasis, ...rest } = node;
      work.nodes[id] = childrenBasis === undefined ? rest : { ...rest, children: "unopened" };
      work.taken.add(id);    }
    work.stats.carried += 1;
  } else {
    const out = await ask(work, "survey", surveyText, SurveyOutput, (v) => checkSurvey(work, v));
    survey = buildSurvey(work, out, basis);
  }
  inputs.onProgress?.(snapshotOf(work, survey, systems, basis));

  const topParts = survey.parts.map((id) => work.nodes[id]!);
  const tasks: (() => Promise<void>)[] = [];
  const builders: (() => void)[] = [];
  for (const part of topParts) {
    if (part.anchor.files.length < MIN_TO_SPLIT) continue;
    const prompt = childrenPrompt(work.ctx, survey.summary, topParts, part);
    const b = hashOf(prompt);
    if (carryChildren(work, part, b)) continue;
    let out: ChildrenOutput | undefined;
    tasks.push(async () => {
      out = await ask(work, `part:${part.title}`, prompt, ChildrenOutput, (v) => checkChildren(part, v));
    });
    builders.push(() => out && buildChildren(work, part, out, b));
  }
  for (const id of survey.journeys) {
    const journey = work.nodes[id]!;
    const tree = work.trees.get(journey.entry!)!;
    const rules = journeyRules(tree);
    const prompt = stepsPrompt(work.ctx, survey.summary, topParts, journey, tree, rules.mustCover);
    const b = hashOf(prompt);
    if (carryChildren(work, journey, b)) continue;
    let out: StepsOutput | undefined;
    tasks.push(async () => {
      out = await ask(work, `journey:${journey.title}`, prompt, StepsOutput, (v) => checkSteps(v, rules));
    });
    builders.push(() => out && buildSteps(work, journey, tree, out, b));
  }
  const settled = await Promise.allSettled([pool(tasks, inputs.concurrency ?? DEFAULT_CONCURRENCY)]);
  for (const build of builders) build();
  inputs.onProgress?.(snapshotOf(work, survey, systems, basis));
  if (settled[0]!.status === "rejected") throw settled[0]!.reason;

  const journeys = survey.journeys.map((id) => {
    const node = work.nodes[id]!;
    const steps = Array.isArray(node.children) ? node.children.map((c) => work.nodes[c]!) : [];
    return { node, steps };
  });
  const extrasText = extrasPrompt(work.ctx, survey.summary, topParts, journeys);
  const extrasBasis = hashOf(extrasText);
  let extras: Extras;
  if (previous?.extras?.basis === extrasBasis) {
    extras = previous.extras;
    work.stats.carried += 1;
  } else {
    const out = await ask(work, "extras", extrasText, ExtrasOutput, (v) => checkExtras(work, v));
    extras = buildExtras(work, out, extrasBasis);
  }
  return { understanding: snapshotOf(work, survey, systems, basis, extras), stats: work.stats };
}

/** Writes the children of an unopened node (the Open pass, D38) and returns the updated tree. */
export async function openNode(
  inputs: UnderstandInputs,
  understanding: Understanding,
  id: string,
): Promise<{ understanding: Understanding; stats: UnderstandStats }> {
  const work = startWork(inputs, understanding.nodes);
  const node = work.nodes[id];
  if (!node) throw new Error(`no node "${id}" in the tree`);
  if (node.children !== "unopened") return { understanding, stats: work.stats };
  const opened = { ...node };
  work.nodes[id] = opened;
  const topParts = understanding.parts.map((p) => work.nodes[p]!);
  if (node.kind === "part") {
    const prompt = childrenPrompt(work.ctx, understanding.summary, topParts, node);
    const out = await ask(work, `open:${node.title}`, prompt, ChildrenOutput, (v) => checkChildren(node, v));
    buildChildren(work, opened, out, hashOf(prompt));
  } else if (node.kind === "journey") {
    const tree = work.trees.get(node.entry ?? "");
    if (!tree) throw new Error(`no call tree for journey ${id}`);
    const rules = journeyRules(tree);
    const prompt = stepsPrompt(work.ctx, understanding.summary, topParts, node, tree, rules.mustCover);
    const out = await ask(work, `journey:${node.title}`, prompt, StepsOutput, (v) => checkSteps(v, rules));
    buildSteps(work, opened, tree, out, hashOf(prompt));
  } else if (node.kind === "step") {    const { journey, tree } = journeyOf(work, node);
    const subtrees = nodesFor(tree, node.anchor.functions).map((root): CallTree => ({ ...tree, root }));
    const rules = subStepRules(tree, node);
    const prompt = subStepsPrompt(work.ctx, understanding.summary, journey, node, subtrees);
    const out = await ask(work, `open:${node.title}`, prompt, StepsOutput, (v) => checkSteps(v, rules));
    buildSteps(work, opened, tree, out, hashOf(prompt));
  } else {
    throw new Error(`can't open a ${node.kind} node`);
  }
  return { understanding: { ...understanding, nodes: sortedNodes(work.nodes) }, stats: work.stats };
}
