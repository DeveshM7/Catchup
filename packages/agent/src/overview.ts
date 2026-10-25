import { createHash } from "node:crypto";
import { flowFamilies, type CallTree, type FlowFamily, type FunctionTreeNode } from "@catchup/analyzer";
import { renderSnippets, renderTree, treeFunctions, type BriefInputs } from "./brief.js";
import { askStructured, type Runner } from "./droid.js";
import { LEGEND } from "./prompts.js";
import { OverviewOutput, type Overview, type OverviewFlow, type OverviewPart } from "./schemas.js";

/** A second family is a main flow only if it scores at least this share of the top one (D34). */
export const SECOND_FLOW_SHARE = 0.6;
const MAX_MAIN_FLOWS = 2;
const MIN_PARTS = 2;
const MAX_PARTS = 4;
const MIN_STEPS = 3;
const MAX_STEPS = 5;
// Asked-for lengths; the validator allows some slack so a word over doesn't fail the run.
const MAX_SUMMARY_WORDS = 30;
const MAX_STEP_WORDS = 18;
const SUMMARY_WORDS_LIMIT = 40;
const STEP_WORDS_LIMIT = 24;
const README_CHARS = 2500;

export type MainFlow = { family: FlowFamily; tree: CallTree };

/** The top flow family, plus the second when it is nearly as big (D32, D34). */
export function mainFlows(trees: CallTree[]): MainFlow[] {
  const byEntry = new Map(trees.map((t) => [t.entryPoint.id, t]));
  const families = flowFamilies(trees);
  const top = families[0];
  if (!top) return [];
  return families
    .slice(0, MAX_MAIN_FLOWS)
    .filter((f) => f === top || f.score >= SECOND_FLOW_SHARE * top.score)
    .map((family) => ({ family, tree: byEntry.get(family.representative)! }));
}

export function dirOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? "." : file.slice(0, at);
}

const fileOf = (fn: string): string => fn.slice(0, fn.indexOf("#"));

/** Folders the main flows run through, sorted. */
export function overviewDirs(flows: MainFlow[]): string[] {
  const dirs = new Set<string>();
  for (const { tree } of flows) for (const fn of treeFunctions(tree)) dirs.add(dirOf(fileOf(fn)));
  return [...dirs].sort();
}

/** Tools the model may call straight from the handler (D33). */
export function toolFunctions(tree: CallTree): string[] {
  return tree.root.children.flatMap((c) => (c.kind === "function" && c.site?.tool ? [c.fn] : []));
}

/** Arrows for the parts diagram: caller part → callee part, part → system. Computed, never drawn by Claude. */
export function overviewLinks(parts: OverviewPart[], flows: MainFlow[]): { from: string; to: string }[] {
  const partOfDir = new Map(parts.flatMap((p) => p.dirs.map((d) => [d, p.id] as const)));
  const partOf = (fn: string): string | undefined => partOfDir.get(dirOf(fileOf(fn)));
  const links = new Set<string>();
  const walk = (node: FunctionTreeNode): void => {
    const from = partOf(node.fn);
    for (const child of node.children) {
      const to: string | undefined =
        child.kind === "function" ? partOf(child.fn) : child.kind === "external" && child.system ? `system:${child.system}` : undefined;
      if (from !== undefined && to !== undefined && to !== from) links.add(`${from}\n${to}`);
      if (child.kind === "function") walk(child);
    }
  };
  for (const { tree } of flows) walk(tree.root);
  return [...links].sort().map((l) => {
    const [from = "", to = ""] = l.split("\n");
    return { from, to };
  });
}

/** README text without HTML, images and badges, trimmed. */
export function readmeExcerpt(text: string | undefined): string {
  if (!text) return "";
  const clean = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > README_CHARS ? `${clean.slice(0, README_CHARS)}…` : clean;
}

export type OverviewInputs = {
  flows: MainFlow[];
  brief: BriefInputs;
  /** `name — description` from package.json, if any. */
  packageLine: string;
  readme: string;
};

function flowBlock({ family, tree }: MainFlow, brief: BriefInputs): string {
  const tools = toolFunctions(tree);
  return [
    `### Flow ${tree.entryPoint.id}`,
    `Entry point: ${tree.entryPoint.label} (handler [${tree.entryPoint.handler}])` +
      (family.members.length > 1 ? `; stands for ${family.members.length} entry points that run mostly the same code` : ""),
    `External systems: ${tree.systems.join(", ") || "none"}`,
    tools.length ? `AI tools the model can call: ${tools.map((t) => `[${t}]`).join(", ")}` : "",
    "Call tree:",
    renderTree(tree, brief),
    "Source of the key functions:",
    renderSnippets(tree, brief) || "(none)",
  ]
    .filter(Boolean)
    .join("\n");
}

export function overviewPrompt(inputs: OverviewInputs): string {
  const dirs = overviewDirs(inputs.flows);
  return [
    "You are writing the first screen a developer sees when opening a codebase for the first time. They should understand what the app is and how its main flow works in under a minute.",
    "",
    `Package: ${inputs.packageLine || "(no package.json description)"}`,
    "README (excerpt):",
    inputs.readme || "(none)",
    "",
    `The main flows below were picked by code as the ones that matter most. ${LEGEND}`,
    "",
    ...inputs.flows.map((f) => flowBlock(f, inputs.brief)),
    "",
    "Return:",
    `- summary: one sentence, at most ${MAX_SUMMARY_WORDS} words, saying what the app is and does for its user. Plain words; no file paths or function names.`,
    `- parts: group these folders into ${MIN_PARTS}–${MAX_PARTS} parts by what they do (e.g. "Chat API", "AI tools", "Database access"). Each part: id (kebab-case), name (1–3 words), description (one sentence, at most 15 words), dirs (folders exactly as written). Every folder goes in exactly one part. External systems are shown separately; don't make parts for them.`,
    `  Folders: ${dirs.join(", ")}`,
    `- flows: one per flow above, entry = the flow id after "### Flow". title: 2–5 words naming what the user does (e.g. "Sending a message"). steps: ${MIN_STEPS}–${MAX_STEPS} steps, each one short sentence (at most ${MAX_STEP_WORDS} words) at the level of ideas, e.g. "You send a message → the server loads the chat and calls the AI model." Fold checks (auth, validation, rate limits) into a step instead of giving them their own. If the model can call tools, say what they do. No function names or file paths in the text.`,
    "  Each step's functions: the function IDs it describes, copied exactly from inside [ ]. The first step must include the handler.",
  ].join("\n");
}

const words = (text: string): number => text.trim().split(/\s+/).length;

/** Problems with Claude's overview; empty when it can be stored. */
export function validateOverview(output: OverviewOutput, flows: MainFlow[]): string[] {
  const errors: string[] = [];
  if (words(output.summary) > SUMMARY_WORDS_LIMIT) errors.push(`summary has ${words(output.summary)} words (max ${MAX_SUMMARY_WORDS})`);

  const dirs = overviewDirs(flows);
  const min = Math.min(MIN_PARTS, dirs.length);
  if (output.parts.length < min || output.parts.length > MAX_PARTS) errors.push(`expected ${min}–${MAX_PARTS} parts, got ${output.parts.length}`);
  const ids = new Set<string>();
  const placed = new Map<string, string>();
  for (const part of output.parts) {
    if (ids.has(part.id)) errors.push(`part id "${part.id}" is used twice`);
    ids.add(part.id);
    for (const dir of part.dirs) {
      if (!dirs.includes(dir)) errors.push(`part "${part.id}" lists unknown folder "${dir}"`);
      const other = placed.get(dir);
      if (other !== undefined) errors.push(`folder "${dir}" is in both "${other}" and "${part.id}"`);
      placed.set(dir, part.id);
    }
  }
  const unplaced = dirs.filter((d) => !placed.has(d));
  if (unplaced.length) errors.push(`folders in no part: ${unplaced.join(", ")}`);

  const expected = flows.map((f) => f.tree.entryPoint.id);
  const got = output.flows.map((f) => f.entry);
  if (JSON.stringify([...got].sort()) !== JSON.stringify([...expected].sort())) {
    errors.push(`expected flows ${expected.join(", ")}; got ${got.join(", ") || "none"}`);
  }
  for (const flow of output.flows) {
    const main = flows.find((f) => f.tree.entryPoint.id === flow.entry);
    if (!main) continue;
    const allowed = treeFunctions(main.tree);
    const name = `flow ${flow.entry}`;
    if (flow.steps.length < MIN_STEPS || flow.steps.length > MAX_STEPS) errors.push(`${name}: expected ${MIN_STEPS}–${MAX_STEPS} steps, got ${flow.steps.length}`);
    const cited = new Set<string>();
    flow.steps.forEach((step, i) => {
      const where = `${name} step ${i + 1}`;
      if (words(step.text) > STEP_WORDS_LIMIT) errors.push(`${where} has ${words(step.text)} words (max ${MAX_STEP_WORDS})`);
      if (step.functions.length === 0) errors.push(`${where} lists no functions`);
      for (const fn of step.functions) {
        if (allowed.has(fn)) cited.add(fn);
        else errors.push(`${where} cites "${fn}", which is not a function in this flow`);
      }
    });
    if (!flow.steps[0]?.functions.includes(main.tree.root.fn)) errors.push(`${name}: the first step must include the handler ${main.tree.root.fn}`);
    const tools = toolFunctions(main.tree);
    if (tools.length > 0 && !tools.some((t) => cited.has(t))) errors.push(`${name}: no step covers the AI tools (${tools.join(", ")})`);
  }
  return errors;
}

export type ExplainOverviewOptions = {
  inputs: OverviewInputs;
  previous?: Overview;
  runner: Runner;
  onCall?: (job: string, attempt: number) => void;
  onRejected?: (job: string, problems: string[]) => void;
};

/** Writes the first screen, or copies the previous one when its inputs are unchanged (D4). */
export async function explainOverview(options: ExplainOverviewOptions): Promise<{ overview: Overview | undefined; carried: boolean }> {
  const { flows } = options.inputs;
  const top = flows[0];
  if (!top) return { overview: undefined, carried: false };
  const prompt = overviewPrompt(options.inputs);
  const basis = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  if (options.previous?.basis === basis) return { overview: options.previous, carried: true };
  const output = await askStructured({
    job: "overview",
    prompt,
    schema: OverviewOutput,
    check: (value) => validateOverview(value, flows),
    runner: options.runner,
    onCall: options.onCall,
    onRejected: options.onRejected,
  });
  const parts: OverviewPart[] = output.parts.map((p) => ({ ...p, dirs: [...p.dirs].sort() }));
  const flowList: OverviewFlow[] = flows.map(({ family, tree }) => {
    const written = output.flows.find((f) => f.entry === tree.entryPoint.id)!;
    return { entry: tree.entryPoint.id, family: family.id, members: family.members.length, title: written.title, steps: written.steps };
  });
  const systems = [...new Set(flows.flatMap((f) => f.tree.systems))].sort();
  const overview: Overview = {
    summary: output.summary,
    parts,
    systems,
    links: overviewLinks(parts, flows),
    flows: flowList,
    startHere: top.tree.entryPoint.file,
    basis,
  };
  return { overview, carried: false };
}
