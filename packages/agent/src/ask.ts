import type { Facts } from "@catchup/analyzer";
import * as z from "zod/v4";
import { askStructured, type Runner } from "./droid.js";
import { commonDir, type Understanding, type UnderstandingNode } from "./tree.js";
import { checkCount, words } from "./treecheck.js";

/** Ask (Build 5, D56): a read-only agent answers a question about the code; every cite is checked against the facts. */

export const ANSWER_WORDS = { ask: 150, limit: 220 } as const;
export const MAX_CITES = 8;
const MAX_HISTORY = 3;
const MAX_LISTED_FILES = 40;

export const AskOutput = z.object({
  answer: z.string().min(1),
  cites: z.array(z.string().min(1)),
});
export type AskOutput = z.infer<typeof AskOutput>;

export type AskTurn = { question: string; answer: string };

export type AskInputs = {
  facts: Facts;
  understanding: Understanding;
  question: string;
  /** The box the question is about, if any. */
  node?: string;
  /** Earlier turns of this chat, oldest first. */
  history?: AskTurn[];
  /** Absolute folder holding the digests, and their file names (the agent may Read them). */
  digestDir: string;
  digestNames: string[];
  maxToolCalls: number;
  runner: Runner;
  onCall?: (job: string, attempt: number) => void;
  onRejected?: (job: string, problems: string[]) => void;
};

/** A checked answer: cites split by what they point at. */
export type Answer = { answer: string; nodes: string[]; functions: string[]; files: string[] };

function nodeLine(node: UnderstandingNode): string {
  const where = node.kind === "part" ? ` — ${commonDir(node.anchor.files) || "(several folders)"}, ${node.anchor.files.length} files` : "";
  return `[${node.id}] ${node.title}: ${node.short}${where}`;
}

/** The tree as a reader's map: parts (two levels), journeys and their steps, systems. */
function treeMap(u: Understanding): string[] {
  const lines = [`The app: ${u.summary}`, "", "Parts:"];
  const children = (node: UnderstandingNode | undefined): UnderstandingNode[] =>
    node && Array.isArray(node.children) ? node.children.flatMap((id) => u.nodes[id] ?? []) : [];
  for (const id of u.parts) {
    const part = u.nodes[id];
    if (!part) continue;
    lines.push(`- ${nodeLine(part)}`, ...children(part).map((c) => `  - ${nodeLine(c)}`));
  }
  lines.push("", "Main journeys:");
  for (const id of u.journeys) {
    const journey = u.nodes[id];
    if (!journey) continue;
    lines.push(`- [${journey.id}] ${journey.title}: ${journey.short}`);
    children(journey).forEach((s, i) => lines.push(`  ${i + 1}. [${s.id}] ${s.title}${s.stepKind && s.stepKind !== "main" ? ` (${s.stepKind})` : ""} — ${s.anchor.functions.slice(0, 3).join(", ")}`));
  }
  lines.push("", `Outside systems and tools: ${u.systems.map((id) => u.nodes[id]?.title ?? id).join(", ") || "none"}`);
  if (u.otherFlows.length) lines.push("", "Other flows:", ...u.otherFlows.map((f) => `- ${f.label}: ${f.line}`));
  return lines;
}

function selected(u: Understanding, id: string): string[] {
  const node = u.nodes[id];
  if (!node) return [];
  const parentOf = new Map(Object.values(u.nodes).flatMap((n) => (Array.isArray(n.children) ? n.children.map((c) => [c, n] as const) : [])));
  const parents: UnderstandingNode[] = [];
  for (let at = parentOf.get(id); at; at = parentOf.get(at.id)) parents.unshift(at);
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => u.nodes[c] ?? []) : [];
  const files = node.anchor.files;
  return [
    `The question is about this box: ${nodeLine(node)}`,
    node.long,
    parents.length ? `Inside: ${parents.map((p) => p.title).join(" › ")}` : "",
    node.systems?.length ? `Outside systems: ${node.systems.join(", ")}` : "",
    node.anchor.functions.length ? `Its functions: ${node.anchor.functions.join(", ")}` : "",
    `Its files (${files.length}): ${files.slice(0, MAX_LISTED_FILES).join(", ")}${files.length > MAX_LISTED_FILES ? ", …" : ""}`,
    kids.length ? `Inside it: ${kids.map((k) => `[${k.id}] ${k.title}`).join("; ")}` : "",
  ].filter(Boolean);
}

export function askPrompt(inputs: Omit<AskInputs, "runner">): string {
  const history = (inputs.history ?? []).slice(-MAX_HISTORY);
  return [
    "You answer a developer's question about this codebase, as a senior engineer who knows it well.",
    `You are a read-only agent: Read, Grep, Glob and LS inside the repository, at most ${inputs.maxToolCalls} tool calls. Read the code that answers the question rather than guessing; the map below was computed from the code and written by an earlier pass.`,
    `Digests you can Read in ${inputs.digestDir}: ${inputs.digestNames.join(", ")} (files.md lists every source file; flow-*.md hold call trees).`,
    "",
    "=== Map ===",
    ...treeMap(inputs.understanding),
    "",
    ...(inputs.node ? [...selected(inputs.understanding, inputs.node), ""] : []),
    ...(history.length ? ["=== Earlier in this chat ===", ...history.flatMap((t) => [`Q: ${t.question}`, `A: ${t.answer}`]), ""] : []),
    "=== Question ===",
    inputs.question,
    "",
    "Return:",
    `- answer: at most ${ANSWER_WORDS.ask} words, plain and direct. Name code in backticks (\`saveChat\`, \`lib/db/queries.ts\`), not by id. If the code doesn't do what is asked, say so. Say what you are unsure of.`,
    `- cites: 1–${MAX_CITES} things the answer is about, most relevant first, copied exactly: box ids from the map (in [ ]), function ids (\`path#name\`), or repo-relative file paths. Only things you saw in the code or the digests.`,
  ].join("\n");
}

/** A cite as written, without the decoration Claude copies from the map (`[id]`, backticks, `()`). */
export const citeKey = (raw: string): string => raw.trim().replace(/^[[`]+|[\]`]+$/g, "").replace(/\(\)$/, "").trim();

/** Problems with an answer; empty when every cite resolves. */
export function checkAnswer(out: AskOutput, facts: Facts, u: Understanding): string[] {
  const files = new Set(facts.files.map((f) => f.path));
  const functions = new Set(facts.functions.map((f) => f.id));
  const problems = checkCount("cites", out.cites.length, 1, MAX_CITES);
  const n = words(out.answer);
  if (n > ANSWER_WORDS.limit) problems.push(`answer has ${n} words (at most ${ANSWER_WORDS.ask})`);
  for (const raw of out.cites) {
    const cite = citeKey(raw);
    if (u.nodes[cite] || functions.has(cite) || files.has(cite)) continue;
    problems.push(`cite "${raw}" is not a box id, function id or source file path`);
  }
  return problems;
}

export function splitCites(cites: string[], facts: Facts, u: Understanding): Omit<Answer, "answer"> {
  const functions = new Set(facts.functions.map((f) => f.id));
  const unique = [...new Set(cites.map(citeKey))];
  return {
    nodes: unique.filter((c) => u.nodes[c] !== undefined),
    functions: unique.filter((c) => u.nodes[c] === undefined && functions.has(c)),
    files: unique.filter((c) => u.nodes[c] === undefined && !functions.has(c)),
  };
}

/** Asks once (one retry on invalid cites) and returns the checked answer. */
export async function askQuestion(inputs: AskInputs): Promise<Answer> {
  const out = await askStructured({
    job: "ask",
    prompt: askPrompt(inputs),
    schema: AskOutput,
    check: (value) => checkAnswer(value, inputs.facts, inputs.understanding),
    runner: inputs.runner,
    onCall: inputs.onCall,
    onRejected: inputs.onRejected,
  });
  return { answer: out.answer, ...splitCites(out.cites, inputs.facts, inputs.understanding) };
}
