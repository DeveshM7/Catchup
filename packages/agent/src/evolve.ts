import type { CallTree, Facts } from "@catchup/analyzer";
import * as z from "zod/v4";
import { subtreeFunctions } from "./journey.js";
import { fileOf, hashOf, stepId, StepsOutput, WORDS, type Extras, type OtherFlow, type Understanding, type UnderstandingNode } from "./tree.js";
import { checkSteps, checkWords } from "./treecheck.js";
import {
  ask,
  DEFAULT_CONCURRENCY,
  journeyNode,
  journeyRules,
  MAX_DEPTH,
  MIN_TO_SPLIT,
  otherFamilies,
  pool,
  snapshotOf,
  sorted,
  startWork,
  systemNodes,
  systemsOfFunctions,
  topPartOf,
  type UnderstandInputs,
  type UnderstandStats,
  type Work,
} from "./understand.js";
import { stepsPrompt } from "./understandPrompts.js";

/**
 * Edit, don't regenerate (D4, Build 6): the tree at commit B is the tree at A carried through what changed. Code maps
 * anchors through renames and deletions, places new files, and keeps every node whose inputs didn't change (same ID,
 * same text, no Claude call). Claude re-tells only journeys whose steps no longer fit, and relabels in one call the parts
 * whose files changed, journeys whose systems changed, and new other flows.
 */

export type EvolveInputs = UnderstandInputs & {
  /** The tree and facts at the earlier commit. */
  from: { understanding: Understanding; facts: Facts };
  /** Files renamed between the two commits, old path → new path. */
  renames: Map<string, string>;
  /**
   * No Claude calls (live preview, Build 7): texts stay as they were, changed journeys keep their steps with the code
   * that still exists, new other flows get no line.
   */
  offline?: boolean;
};

/** Maps ids at A to ids at B: files through renames, functions through their file, entry points through their handler. */
export type Remap = {
  file: (path: string) => string | undefined;
  fn: (id: string) => string | undefined;
  /** True when a function at A still exists at B with a different body. */
  changed: (id: string) => boolean;
  entry: (id: string) => string | undefined;
};

export function remapper(a: Facts, b: Facts, renames: Map<string, string>): Remap {
  const filesB = new Set(b.files.map((f) => f.path));
  const hashA = new Map(a.functions.map((f) => [f.id, f.hash]));
  const hashB = new Map(b.functions.map((f) => [f.id, f.hash]));
  const entriesB = new Set(b.entryPoints.map((e) => e.id));
  const entryByHandler = new Map(b.entryPoints.map((e) => [e.handler, e.id]));
  const handlerA = new Map(a.entryPoints.map((e) => [e.id, e.handler]));
  const file = (path: string): string | undefined => {
    const to = renames.get(path) ?? path;
    return filesB.has(to) ? to : undefined;
  };
  const fn = (id: string): string | undefined => {
    const f = file(fileOf(id));
    const to = f === undefined ? undefined : f + id.slice(fileOf(id).length);
    return to !== undefined && hashB.has(to) ? to : undefined;
  };
  return {
    file,
    fn,
    changed: (id) => {
      const to = fn(id);
      return to !== undefined && hashA.get(id) !== hashB.get(to);
    },
    entry: (id) => {
      if (entriesB.has(id)) return id;
      const handler = handlerA.get(id);
      const to = handler === undefined ? undefined : fn(handler);
      return to === undefined ? undefined : entryByHandler.get(to);
    },
  };
}

const dirParts = (path: string): string[] => path.split("/").slice(0, -1);

/** Shared leading folders of two paths. */
function sharedDepth(a: string, b: string): number {
  const x = dirParts(a);
  const y = dirParts(b);
  let n = 0;
  while (n < x.length && x[n] === y[n]) n += 1;
  return n;
}

/**
 * The node among `candidates` whose files share the most leading folders with `file`; ties go to the one with more files
 * at that depth, then to the first.
 */
/**
 * The candidate a new file belongs with: the deepest shared folder, then the most files sharing it, then the most
 * largest share of imports in common (a new route importing what the vote route imports joins it, not a part that
 * imports everything).
 */
export function closest(file: string, candidates: { files: string[] }[], importsOf: (file: string) => Set<string>): number {
  const mine = importsOf(file);
  let best = 0;
  let bestScore = [-1, 0, 0];
  candidates.forEach((c, i) => {
    const depths = c.files.map((f) => sharedDepth(file, f));
    const depth = Math.max(-1, ...depths);
    const theirs = new Set(c.files.flatMap((f) => [...importsOf(f)]));
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    const score = [depth, depths.filter((d) => d === depth).length, shared / Math.max(1, new Set([...mine, ...theirs]).size)];
    const better = score.findIndex((v, k) => v !== bestScore[k]);
    if (better !== -1 && score[better]! > bestScore[better]!) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

type PartChange = { id: string; added: string[]; removed: string[] };

/** Parts at B: A's parts with their files remapped, new files placed by folder, empty parts dropped. */
function evolveParts(work: Work, before: Understanding, map: Remap): { parts: string[]; changes: PartChange[] } {
  const changes: PartChange[] = [];
  const draft = new Map<string, { node: UnderstandingNode; files: string[]; removed: string[] }>();
  const walk = (id: string): void => {
    const node = before.nodes[id];
    if (!node) return;
    const files = node.anchor.files.flatMap((f) => map.file(f) ?? []);
    draft.set(id, { node, files, removed: node.anchor.files.filter((f) => map.file(f) === undefined) });
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  before.parts.forEach(walk);

  const placed = new Set(before.parts.flatMap((id) => draft.get(id)?.files ?? []));
  const imports = new Map<string, Set<string>>();
  for (const imp of work.inputs.facts.imports) imports.set(imp.from, (imports.get(imp.from) ?? new Set()).add(imp.to));
  const importsOf = (f: string): Set<string> => imports.get(f) ?? new Set();
  const added = new Map<string, string[]>();
  for (const file of work.allFiles.filter((f) => !placed.has(f))) {
    let level = before.parts.filter((id) => draft.has(id));
    while (level.length > 0) {
      const id = level[closest(file, level.map((p) => draft.get(p)!), importsOf)]!;
      draft.get(id)!.files.push(file);
      added.set(id, [...(added.get(id) ?? []), file]);
      const children = draft.get(id)!.node.children;
      level = Array.isArray(children) ? children.filter((c) => draft.has(c)) : [];
    }
  }

  const keep = (id: string): boolean => (draft.get(id)?.files.length ?? 0) > 0;
  for (const [id, { node, files, removed }] of draft) {
    if (!keep(id)) continue;
    const anchorFiles = sorted(files);
    const children = Array.isArray(node.children) ? node.children.filter(keep) : node.children;
    // A leaf only because it was small re-opens when it grows; a leaf Claude chose (childrenBasis) stays one.
    const regrown = node.children === "leaf" && node.childrenBasis === undefined && anchorFiles.length >= MIN_TO_SPLIT && node.depth < MAX_DEPTH;
    work.nodes[id] = { ...node, anchor: { files: anchorFiles, functions: [] }, children: regrown ? "unopened" : children };
    work.taken.add(id);
    const add = added.get(id) ?? [];
    if (add.length || removed.length) changes.push({ id, added: add, removed });
  }
  return { parts: before.parts.filter(keep), changes };
}

/** Copies a node's opened subtree when every function it cites still exists, remapped; else marks it unopened. */
function carrySubtree(work: Work, before: Understanding, node: UnderstandingNode, map: Remap): UnderstandingNode["children"] {
  if (!Array.isArray(node.children)) return node.children;
  const ok = (id: string): boolean => {
    const child = before.nodes[id];
    return child !== undefined && child.anchor.functions.every((f) => map.fn(f) !== undefined && !map.changed(f)) && (!Array.isArray(child.children) || child.children.every(ok));
  };
  if (!node.children.every(ok)) return "unopened";
  const copy = (id: string): void => {
    const child = before.nodes[id]!;
    const functions = child.anchor.functions.map((f) => map.fn(f)!);
    work.nodes[id] = { ...child, anchor: { files: sorted(functions.map(fileOf)), functions }, systems: systemsOfFunctions(work, functions) };
    work.taken.add(id);
    if (Array.isArray(child.children)) child.children.forEach(copy);
  };
  node.children.forEach(copy);
  return node.children;
}

type JourneyPlan = { id: string; tree: CallTree; steps: UnderstandingNode[]; touched: Set<string>; problems: string[] };

/** A journey at B: same id and text; its steps kept when they still fit and their code didn't change, else re-told. */
function evolveJourney(work: Work, before: Understanding, id: string, map: Remap, parts: string[]): JourneyPlan | undefined {
  const old = before.nodes[id];
  const entry = old?.entry === undefined ? undefined : map.entry(old.entry);
  const tree = entry === undefined ? undefined : work.trees.get(entry);
  if (!old || entry === undefined || !tree) return undefined;
  const node = { ...journeyNode(work, entry, { title: old.title, short: old.short, long: old.long }, parts, old.basis), id };
  if (old.childrenBasis !== undefined) node.childrenBasis = old.childrenBasis;
  work.nodes[id] = node;
  work.taken.add(id);
  const steps = Array.isArray(old.children) ? old.children.flatMap((c) => before.nodes[c] ?? []) : [];
  const touched = new Set(steps.filter((s) => s.anchor.functions.some((f) => map.fn(f) === undefined || map.changed(f))).map((s) => s.id));
  const out: StepsOutput = {
    steps: steps.map((s) => ({ title: s.title, short: s.short, long: s.long, kind: s.stepKind ?? "main", functions: s.anchor.functions.flatMap((f) => map.fn(f) ?? []), open: s.children !== "leaf" })),
  };
  const problems = steps.length ? checkSteps(out, journeyRules(tree)) : ["no steps yet"];
  if (problems.length === 0 && touched.size === 0) {
    node.children = steps.map((s) => {
      const functions = s.anchor.functions.map((f) => map.fn(f)!);
      work.nodes[s.id] = { ...s, anchor: { files: sorted(functions.map(fileOf)), functions }, parts: sorted(functions.flatMap((f) => topPartOf(work, parts)(fileOf(f)) ?? [])), systems: systemsOfFunctions(work, functions), children: carrySubtree(work, before, s, map) };
      work.taken.add(s.id);
      return s.id;
    });
    return undefined;
  }
  node.children = old.children;
  return { id, tree, steps, touched, problems };
}

function updatePrompt(work: Work, before: Understanding, plan: JourneyPlan, map: Remap, summary: string, parts: UnderstandingNode[]): string {
  const journey = work.nodes[plan.id]!;
  const rules = journeyRules(plan.tree);
  const fnsBefore = new Set(before.nodes[plan.id]?.anchor.functions.flatMap((f) => map.fn(f) ?? []) ?? []);
  const fnsNow = journey.anchor.functions;
  const added = fnsNow.filter((f) => !fnsBefore.has(f));
  const gone = (before.nodes[plan.id]?.anchor.functions ?? []).filter((f) => map.fn(f) === undefined);
  const changed = (before.nodes[plan.id]?.anchor.functions ?? []).filter((f) => map.changed(f)).map((f) => map.fn(f)!);
  return [
    stepsPrompt(work.ctx, summary, parts, journey, plan.tree, rules.mustCover),
    "",
    "=== This journey was told before; the code changed since. Change as little as possible. ===",
    "Previous steps (functions as they are now; a step marked CHANGED cites code that changed or is gone):",
    ...plan.steps.map((s, i) => `${i + 1}. ${plan.touched.has(s.id) ? "CHANGED " : ""}[${s.stepKind ?? "main"}] ${s.title}: ${s.short} — ${s.anchor.functions.flatMap((f) => map.fn(f) ?? [`(gone) ${f}`]).join(", ")}`),
    `Functions whose code changed: ${changed.join(", ") || "none"}`,
    `Functions no longer reached: ${gone.join(", ") || "none"}`,
    `Functions newly reached: ${added.slice(0, 40).join(", ") || "none"}${added.length > 40 ? ", …" : ""}`,
    `Problems with the previous steps on the new code: ${plan.problems.join("; ") || "none"}`,
    "Return the steps again: keep every unchanged step with exactly the same functions and text; rewrite only what the change affects; add or drop steps only when the code did.",
  ].join("\n");
}

/** Builds the re-told steps: a step citing exactly the functions of an earlier one keeps its id (and its text, if untouched). */
function buildUpdatedSteps(work: Work, before: Understanding, plan: JourneyPlan, out: StepsOutput, parts: string[], map: Remap, basis: string): void {
  const journey = work.nodes[plan.id]!;
  const key = (fns: string[]): string => sorted(fns).join("\n");
  const now = (s: UnderstandingNode): string[] => s.anchor.functions.flatMap((f) => map.fn(f) ?? []);
  // Several steps can cite the same functions (a handler's "click" and "update the screen"): each is matched once, in order.
  const previous = new Map<string, UnderstandingNode[]>();
  for (const s of plan.steps) previous.set(key(now(s)), [...(previous.get(key(now(s))) ?? []), s]);
  const partOf = topPartOf(work, parts);
  // Same functions → same step. Otherwise the earlier step it overlaps most (≥ half, or the same title) keeps its id:
  // a re-cut step is a changed step, not one removed and one added (D57).
  const used = new Set<string>();
  const exact = out.steps.map((s) => {
    const o = previous.get(key([...new Set(s.functions)]))?.find((p) => !used.has(p.id));
    if (o) used.add(o.id);
    return o;
  });
  const matchOf = (s: StepsOutput["steps"][number], i: number): UnderstandingNode | undefined => {
    if (exact[i]) return exact[i];
    let best: { node: UnderstandingNode; score: number } | undefined;
    for (const p of plan.steps) {
      if (used.has(p.id)) continue;
      const a = new Set(now(p));
      const shared = s.functions.filter((f) => a.has(f)).length;
      const score = Math.max(shared / new Set([...a, ...s.functions]).size, p.title === s.title ? 1 : 0);
      if (score >= 0.5 && (!best || score > best.score)) best = { node: p, score };
    }
    if (best) used.add(best.node.id);
    return best?.node;
  };
  const matches = out.steps.map(matchOf);
  journey.childrenBasis = basis;
  journey.children = out.steps.map((s, i) => {
    const functions = [...new Set(s.functions)];
    const old = matches[i];
    const keepText = old !== undefined && exact[i] === old && !plan.touched.has(old.id);
    const id = old?.id ?? stepId(plan.id, functions, work.taken);
    work.taken.add(id);
    const big = subtreeFunctions(plan.tree, functions).size >= MIN_TO_SPLIT;
    work.nodes[id] = {
      id,
      kind: "step",
      title: keepText ? old.title : s.title,
      short: keepText ? old.short : s.short,
      long: keepText ? old.long : s.long,
      anchor: { files: sorted(functions.map(fileOf)), functions },
      parts: sorted(functions.flatMap((f) => partOf(fileOf(f)) ?? [])),
      systems: systemsOfFunctions(work, functions),
      stepKind: keepText ? (old.stepKind ?? s.kind) : s.kind,
      children: keepText ? carrySubtree(work, before, old, map) : s.open && big && journey.depth + 1 < MAX_DEPTH ? "unopened" : "leaf",
      depth: journey.depth + 1,
      basis: keepText ? old.basis : basis,
    };
    return id;
  });
}

// ---------- Relabel (one call) ----------

export const RelabelOutput = z.object({
  items: z.array(z.object({ key: z.string(), title: z.string().min(1), short: z.string().min(1), long: z.string().min(1) })),
  otherFlows: z.array(z.object({ family: z.string(), line: z.string().min(1) })),
});
export type RelabelOutput = z.infer<typeof RelabelOutput>;

type RelabelItem = { key: string; id: string; lines: string[] };

function relabelPrompt(summary: string, items: RelabelItem[], flows: { family: string; label: string; systems: string[] }[]): string {
  return [
    "You keep a codebase map up to date. The code changed; update only what is listed. Change as little as possible: keep a title if it still fits.",
    `Writing rules: title at most ${WORDS.title.ask} words; short one line, at most ${WORDS.short.ask} words; long at most ${WORDS.long.ask} words. No file paths in title or short.`,
    "",
    `The app: ${summary}`,
    "",
    ...(items.length ? ["Boxes to update (key: what it was, and what changed):", ...items.flatMap((i) => [`- ${i.key}:`, ...i.lines.map((l) => `    ${l}`)]), ""] : []),
    ...(flows.length ? ["New flows that need one line each (at most 15 words: what it does for the user):", ...flows.map((f) => `- ${f.family}: ${f.label}${f.systems.length ? ` (uses ${f.systems.join(", ")})` : ""}`), ""] : []),
    "Return items (one per key, same keys) and otherFlows (one per flow, family exactly as given).",
  ].join("\n");
}

function checkRelabel(out: RelabelOutput, items: RelabelItem[], flows: { family: string }[]): string[] {
  const problems: string[] = [];
  const keys = items.map((i) => i.key);
  const got = out.items.map((i) => i.key);
  if (JSON.stringify([...got].sort()) !== JSON.stringify([...keys].sort())) problems.push(`items must have exactly the keys ${keys.join(", ") || "(none)"}; got ${got.join(", ") || "none"}`);
  out.items.forEach((i) => problems.push(...checkWords(`item ${i.key}`, { title: i.title, short: i.short, long: i.long })));
  const families = flows.map((f) => f.family);
  const given = out.otherFlows.map((f) => f.family);
  if (JSON.stringify([...given].sort()) !== JSON.stringify([...families].sort())) problems.push(`otherFlows must have exactly the families ${families.join(", ") || "(none)"}`);
  out.otherFlows.forEach((f) => problems.push(...checkWords(`otherFlows ${f.family}`, { line: f.line })));
  return problems;
}

function carryExtras(extras: Extras | undefined, map: Remap): Extras | undefined {
  if (!extras) return undefined;
  const remap = (c: { files: string[]; functions: string[] }): { files: string[]; functions: string[] } => ({
    files: c.files.flatMap((f) => map.file(f) ?? []),
    functions: c.functions.flatMap((f) => map.fn(f) ?? []),
  });
  const cited = <T extends { files: string[]; functions: string[] }>(items: T[]): T[] =>
    items.map((i) => ({ ...i, ...remap(i) })).filter((i) => i.files.length + i.functions.length > 0);
  return {
    glossary: cited(extras.glossary),
    startHere: extras.startHere.flatMap((s) => {
      const file = map.file(s.file);
      return file ? [{ ...s, file }] : [];
    }),
    changes: cited(extras.changes),
    surprises: cited(extras.surprises),
    basis: extras.basis,
  };
}

/** The tree at B, evolved from the tree at A (Build 6). */
export async function evolve(inputs: EvolveInputs): Promise<{ understanding: Understanding; stats: UnderstandStats }> {
  const before = inputs.from.understanding;
  const map = remapper(inputs.from.facts, inputs.facts, inputs.renames);
  const work = startWork(inputs);
  const systems = systemNodes(work);
  const { parts, changes } = evolveParts(work, before, map);

  const plans = before.journeys.flatMap((id) => evolveJourney(work, before, id, map, parts) ?? []);
  const journeys = before.journeys.filter((id) => work.nodes[id] !== undefined);

  // Relabel: parts whose files changed, journeys whose outside systems changed, new other flows.
  const items: RelabelItem[] = [];
  changes.forEach((c, i) => {
    const node = work.nodes[c.id]!;
    items.push({
      key: `part${i + 1}`,
      id: c.id,
      lines: [`was: "${node.title}" — ${node.short} ${node.long}`, ...(c.added.length ? [`files added: ${c.added.join(", ")}`] : []), ...(c.removed.length ? [`files removed: ${c.removed.join(", ")}`] : [])],
    });
  });
  journeys.forEach((id) => {
    const now = work.nodes[id]!;
    const was = before.nodes[id]!;
    const add = (now.systems ?? []).filter((s) => !(was.systems ?? []).includes(s));
    const gone = (was.systems ?? []).filter((s) => !(now.systems ?? []).includes(s));
    if (add.length || gone.length) {
      items.push({ key: `journey${items.length + 1}`, id, lines: [`was: "${was.title}" — ${was.short} ${was.long}`, ...(add.length ? [`now also uses: ${add.join(", ")}`] : []), ...(gone.length ? [`no longer uses: ${gone.join(", ")}`] : [])] });
    }
  });
  const entries = journeys.map((id) => work.nodes[id]!.entry!);
  const keptLines = new Map(before.otherFlows.flatMap((f) => [[f.family, f.line] as const, [map.entry(f.entry) ?? "", f.line] as const]));
  const families = otherFamilies(work, entries);
  const fresh = families.filter((f) => !keptLines.has(f.id) && !keptLines.has(f.representative));
  const flowBriefs = fresh.map((f) => ({ family: f.id, label: work.trees.get(f.representative)?.entryPoint.label ?? f.representative, systems: f.systems }));

  const lines = new Map<string, string>();
  const relabelBasis = hashOf(relabelPrompt(before.summary, items, flowBriefs));
  const tasks: (() => Promise<void>)[] = [];
  if (inputs.offline) {
    for (const plan of plans) {
      const reached = journeyRules(plan.tree).allowed;
      const kept = plan.steps.flatMap((s) => {
        const functions = s.anchor.functions.flatMap((f) => map.fn(f) ?? []).filter((f) => reached.has(f));
        return functions.length ? [{ title: s.title, short: s.short, long: s.long, kind: s.stepKind ?? "main", functions, open: s.children !== "leaf" }] : [];
      });
      buildUpdatedSteps(work, before, plan, { steps: kept }, parts, map, before.nodes[plan.id]?.childrenBasis ?? before.basis);
    }
  } else if (items.length || flowBriefs.length) {
    tasks.push(async () => {
      const out = await ask(work, "relabel", relabelPrompt(before.summary, items, flowBriefs), RelabelOutput, (v) => checkRelabel(v, items, flowBriefs));
      for (const item of out.items) {
        const target = items.find((i) => i.key === item.key);
        const node = target && work.nodes[target.id];
        if (node) Object.assign(node, { title: item.title, short: item.short, long: item.long, basis: relabelBasis });
      }
      for (const f of out.otherFlows) lines.set(f.family, f.line);
    });
  }
  const topParts = parts.map((id) => work.nodes[id]!);
  const builders: (() => void)[] = [];
  for (const plan of inputs.offline ? [] : plans) {
    const prompt = updatePrompt(work, before, plan, map, before.summary, topParts);
    const rules = journeyRules(plan.tree);
    let out: StepsOutput | undefined;
    tasks.push(async () => {
      out = await ask(work, `update:${work.nodes[plan.id]!.title}`, prompt, StepsOutput, (v) => checkSteps(v, rules));
    });
    builders.push(() => out && buildUpdatedSteps(work, before, plan, out, parts, map, hashOf(prompt)));
  }
  await pool(tasks, inputs.concurrency ?? DEFAULT_CONCURRENCY);
  for (const build of builders) build();

  const otherFlows = families.map((family): OtherFlow => ({
    family: family.id,
    entry: family.representative,
    label: work.trees.get(family.representative)?.entryPoint.label ?? family.representative,
    members: family.members.length,
    line: keptLines.get(family.id) ?? keptLines.get(family.representative) ?? lines.get(family.id) ?? "",
  }));
  const extras = carryExtras(before.extras, map);
  const survey = { summary: before.summary, parts, journeys, otherFlows };
  return { understanding: { ...snapshotOf(work, survey, systems, before.basis, extras), from: before.sha }, stats: work.stats };
}
