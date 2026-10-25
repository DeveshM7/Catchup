import type { CallTree, Facts, Signals } from "@catchup/analyzer";
import { renderTree, type BriefInputs } from "./brief.js";
import { flowDigest, folderTree } from "./digest.js";
import { LEGEND } from "./prompts.js";
import { WORDS, type UnderstandingNode } from "./tree.js";

/** Other flows that get a line on the first screen. */
export const OTHER_FLOWS = 20;
const LIST_FILES_UP_TO = 150;

export type PromptContext = {
  facts: Facts;
  signals: Signals;
  /** file name → markdown. */
  digest: Record<string, string>;
  /** Absolute folder holding the digest files, readable by the agent. */
  digestDir: string;
  maxToolCalls: number;
  brief: BriefInputs;
};

function preamble(ctx: PromptContext): string {
  return [
    "You are a senior engineer helping a developer who has never seen this codebase understand it.",
    `You are a read-only agent: you may use Read, Grep, Glob and LS inside the repository and nothing else, at most ${ctx.maxToolCalls} tool calls. Don't spend them re-reading what this message already gives you.`,
    "The digests in this message were computed from the code; trust them for what exists (files, functions, entry points, calls). Read source files only to check what code does or why.",
    `More digests you can Read in ${ctx.digestDir}: ${Object.keys(ctx.digest).sort().join(", ")}.`,
    "",
    "Writing rules (for a newcomer, plain words):",
    `- title: at most ${WORDS.title.ask} words.`,
    `- short: one line, at most ${WORDS.short.ask} words; don't repeat the title.`,
    `- long: at most ${WORDS.long.ask} words, 2–3 sentences: what it does, why it matters, how it connects to the rest.`,
    "- No file paths or function names in title or short. In long, at most two, in backticks.",
    "",
  ].join("\n");
}

const section = (name: string, body: string): string => `=== ${name} ===\n${body}\n`;

function partsContext(summary: string, parts: UnderstandingNode[]): string {
  return [`The app: ${summary}`, "Top parts:", ...parts.map((p) => `- ${p.title}: ${p.short}`), ""].join("\n");
}

export function surveyPrompt(ctx: PromptContext): string {
  return [
    preamble(ctx),
    "Task: map the whole codebase.",
    "",
    section("repo.md", ctx.digest["repo.md"] ?? ""),
    section("entries.md", ctx.digest["entries.md"] ?? ""),
    "Return:",
    `- summary: one sentence (at most ${WORDS.summary.ask} words): what the app is and what it does for its user. No paths or code names.`,
    "- parts: 2–7 top parts by role (what they do, e.g. \"Chat API\", \"AI tools\", \"Artifacts\", \"Auth\", \"Database access\"), most important first. " +
      "paths: the folders or files (repo-relative, as in files.md) that make up the part. Only the source files listed in files.md count: " +
      "leave out anything not listed there (styles, assets, tests or configs that aren't listed). Every listed file must belong to exactly one part: " +
      "a file goes to the part with the most specific path that contains it, so you can carve a subfolder or a single file out of a broader folder. " +
      "Leftovers (config, tests, scripts) can share a part such as \"Tooling and tests\". Outside systems (databases, AI providers) are shown separately: no parts for them.",
    "- journeys: 1–3 main journeys, the things users do that the app exists for. entry: an entry point id from entries.md, exactly as written inside the backticks. " +
      "Prefer a `ui:` entry whose tree continues into the server, so the journey runs from the browser to the server and back. " +
      "Each journey from a different family: entries in one family run mostly the same code (e.g. a CLI command and the library function it calls). Only entries that reach at least 3 functions; fewer journeys are fine, and none if no such entry exists (pages are screens, never journeys). title: what the user does (\"Sending a message\").",
    `- otherFlows: for the ${OTHER_FLOWS} best-ranked families in entries.md that hold none of your journeys' entry points, one line each (at most ${WORDS.line.ask} words: what it does for the user). family: the id in backticks at the start of its heading, without the backticks.`,
  ].join("\n");
}

function fileLine(ctx: PromptContext, path: string): string {
  const fact = ctx.facts.files.find((f) => f.path === path);
  const names = ctx.facts.functions.filter((fn) => fn.file === path).map((fn) => fn.name);
  const flows = ctx.signals.files[path]?.flows ?? 0;
  const shown = names.slice(0, 6).join(", ");
  return `- ${path} — ${fact?.loc ?? 0} lines${fact?.side ? `, ${fact.side}` : ""}${flows ? `, ${flows} flows` : ""}${names.length ? `; functions: ${shown}${names.length > 6 ? ", …" : ""}` : ""}`;
}

export function childrenPrompt(ctx: PromptContext, summary: string, parts: UnderstandingNode[], node: UnderstandingNode): string {
  const files = node.anchor.files;
  const listing = files.length <= LIST_FILES_UP_TO ? files.map((f) => fileLine(ctx, f)) : [...folderTree(files), "(files.md lists every file)"];
  return [
    preamble(ctx),
    "Task: split one part of the codebase into its sub-parts.",
    "",
    partsContext(summary, parts),
    `This part: "${node.title}" — ${node.long}`,
    `Its files (${files.length}):`,
    ...listing,
    "",
    "Return leaf: true and no children if this part is one cohesive thing a reader would not split further.",
    "Otherwise leaf: false and 2–7 children by role, most important first. paths: folders or files inside this part; " +
      "every file listed above goes to exactly one child (the one with the most specific path that contains it).",
  ].join("\n");
}

const STEP_KINDS =
  "- kind: main = the normal path; check = input, auth or rate-limit checks (put all of them in at most one check step); error = runs only when something fails; branch = an alternative path taken only sometimes.";

export function stepsPrompt(
  ctx: PromptContext,
  summary: string,
  parts: UnderstandingNode[],
  journey: UnderstandingNode,
  tree: CallTree,
  mustCover: string[][],
): string {
  return [
    preamble(ctx),
    "Task: tell one main journey as steps.",
    "",
    partsContext(summary, parts),
    `Journey: "${journey.title}" — ${journey.long}`,
    "",
    section("flow digest (call tree computed from the code)", flowDigest(tree, ctx.brief)),
    "Return 3–7 steps in the order they run, at the level of ideas (what a developer would draw on a whiteboard):",
    "- title, short, long as in the writing rules. Say which outside systems and AI tools a step uses.",
    STEP_KINDS,
    "  Code that runs only on a side path (a command, a retry, another button) goes in a branch step, not in the main steps.",
    `- functions: the function IDs that do the step's work, copied exactly from inside [ ] in the call tree. The first step must include the handler [${tree.root.fn}].`,
    `  Each of these must be in some step (for "a or b", one is enough): ${mustCover.map((g) => g.join(" or ")).join("; ")}.`,
    "- open: true if the step hides enough logic that a reader would want to open it into sub-steps.",
  ].join("\n");
}

export function subStepsPrompt(
  ctx: PromptContext,
  summary: string,
  journey: UnderstandingNode,
  step: UnderstandingNode,
  subtrees: CallTree[],
): string {
  return [
    preamble(ctx),
    "Task: open one step of a journey into its sub-steps.",
    "",
    `The app: ${summary}`,
    `Journey: "${journey.title}" — ${journey.short}`,
    `Step: "${step.title}" — ${step.long}`,
    "",
    `The code behind this step (call trees computed from the code). ${LEGEND}`,
    ...subtrees.map((t) => renderTree(t, ctx.brief)),
    "",
    "Return 2–7 sub-steps in the order they run:",
    "- title, short, long as in the writing rules.",
    STEP_KINDS,
    `- functions: function IDs from inside [ ] above. Together the sub-steps must cite each of: ${step.anchor.functions.join(", ")}.`,
    "- open: true if a sub-step still hides enough logic to open further.",
  ].join("\n");
}

export function extrasPrompt(ctx: PromptContext, summary: string, parts: UnderstandingNode[], journeys: { node: UnderstandingNode; steps: UnderstandingNode[] }[]): string {
  return [
    preamble(ctx),
    "Task: the notes a senior engineer gives a newcomer on day one. Check claims against the code before you make them.",
    "Use your tools for this pass: Read the two or three files you'd send a newcomer to first, and Grep before you say something is unused or missing. " +
      "Look for what the digests can't show: errors that are caught and ignored, work started by a file path or a string, settings that change nothing, features wired on one side only.",
    "",
    partsContext(summary, parts),
    "Main journeys:",
    ...journeys.flatMap(({ node, steps }) => [`- ${node.title}`, ...steps.map((s, i) => `  ${i + 1}. ${s.title}: ${s.short} [${s.anchor.functions.slice(0, 4).join(", ")}]`)]),
    "",
    section("repo.md", ctx.digest["repo.md"] ?? ""),
    section("hot.md", ctx.digest["hot.md"] ?? ""),
    "Return (cites: repo-relative file paths or function IDs exactly as written in the digests; each item needs at least one):",
    "- glossary: 3–8 key ideas a reader must know to follow this codebase (term: 1–3 words; meaning: at most 30 words, what it means here).",
    "- startHere: 2–4 files to read first, best first (file: repo-relative path; why: at most 20 words).",
    "- changes: 3–6 common changes and where to make them (task: at most 10 words, \"Add a new AI tool\"; cites: the files or functions to touch).",
    "- surprises: 0–5 things that would surprise a newcomer: half-wired features, dead ends, mismatches, swallowed errors, duplicated logic (text: at most 35 words). Only what you verified in the code; \"Possibly unused\" in hot.md lists candidates for dead code.",
  ].join("\n");
}
