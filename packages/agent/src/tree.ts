import { createHash } from "node:crypto";
import * as z from "zod/v4";

/** The understanding tree (D37, ARCHITECTURE §6). Claude writes titles and text; code makes IDs, anchors, systems. */
export type NodeKind = "system" | "part" | "journey" | "step";
export type JourneyStepKind = "main" | "check" | "error" | "branch";
export type Anchor = { files: string[]; functions: string[] };

export type UnderstandingNode = {
  /** Made by code: `part:<folder or file>`, `journey:<entry id>`, `<parent id>#<hash>`, `system:<name>`. */
  id: string;
  kind: NodeKind;
  title: string;
  /** ≤ 12 words. */
  short: string;
  /** ≤ 60 words. */
  long: string;
  /** Parts anchor files only; journeys and steps anchor the functions they cite and those functions' files. */
  anchor: Anchor;
  /** Journeys: the entry point. */
  entry?: string;
  /** Journeys and steps: top parts they run through, computed from the anchor. */
  parts?: string[];
  /** Outside systems, computed from the call tree, never by Claude. */
  systems?: string[];
  stepKind?: JourneyStepKind;
  children: string[] | "unopened" | "leaf";
  /** Claude-written level: top parts and journeys are 1. */
  depth: number;
  /** Hash of the prompt this node was written from; same basis → copied, no Claude call (D4). */
  basis: string;
  /** Hash of the prompt that wrote its children (or decided it is a leaf). */
  childrenBasis?: string;
};

const NODE_KEYS: (keyof UnderstandingNode)[] = [
  "id", "kind", "title", "short", "long", "anchor", "entry", "parts", "systems", "stepKind", "children", "depth", "basis", "childrenBasis",
];

/** The node with its keys in one fixed order, so the same tree always serializes to the same bytes. */
export function canonicalNode(node: UnderstandingNode): UnderstandingNode {
  const out: Record<string, unknown> = {};
  for (const key of NODE_KEYS) if (node[key] !== undefined) out[key] = node[key];
  return out as UnderstandingNode;
}
/** A flow family that isn't a main journey, in one line. */
export type OtherFlow = { family: string; entry: string; label: string; members: number; line: string };

export type Cited = { files: string[]; functions: string[] };
export type Extras = {
  glossary: ({ term: string; meaning: string } & Cited)[];
  startHere: { file: string; why: string }[];
  changes: ({ task: string } & Cited)[];
  surprises: ({ text: string } & Cited)[];
  basis: string;
};

export type Understanding = {
  sha: string;
  model: string;
  summary: string;
  /** Top part ids, most important first. */
  parts: string[];
  /** Main journey ids. */
  journeys: string[];
  /** `system:<name>` ids. */
  systems: string[];
  otherFlows: OtherFlow[];
  nodes: Record<string, UnderstandingNode>;
  extras?: Extras;
  /** Basis of the survey pass. */
  basis: string;
};

// Asked-for lengths; the validator allows slack so a word over doesn't fail the run (D34).
export const WORDS = {
  summary: { ask: 25, limit: 32 },
  title: { ask: 5, limit: 8 },
  short: { ask: 12, limit: 15 },
  long: { ask: 60, limit: 75 },
  line: { ask: 15, limit: 20 },
  meaning: { ask: 30, limit: 40 },
  why: { ask: 20, limit: 28 },
  task: { ask: 10, limit: 14 },
  surprise: { ask: 35, limit: 45 },
} as const;

const text = z.string().min(1);
const written = { title: text, short: text, long: text };
const paths = z.array(z.string().min(1));
const cites = z.array(z.string().min(1));

export const SurveyOutput = z.object({
  summary: text,
  parts: z.array(z.object({ ...written, paths })),
  journeys: z.array(z.object({ entry: z.string(), ...written })),
  otherFlows: z.array(z.object({ family: z.string(), line: text })),
});
export type SurveyOutput = z.infer<typeof SurveyOutput>;

export const ChildrenOutput = z.object({
  leaf: z.boolean(),
  children: z.array(z.object({ ...written, paths })),
});
export type ChildrenOutput = z.infer<typeof ChildrenOutput>;

export const StepsOutput = z.object({
  steps: z.array(
    z.object({
      ...written,
      kind: z.enum(["main", "check", "error", "branch"]),
      functions: z.array(z.string()),
      open: z.boolean(),
    }),
  ),
});
export type StepsOutput = z.infer<typeof StepsOutput>;

export const ExtrasOutput = z.object({
  glossary: z.array(z.object({ term: text, meaning: text, cites })),
  startHere: z.array(z.object({ file: z.string(), why: text })),
  changes: z.array(z.object({ task: text, cites })),
  surprises: z.array(z.object({ text, cites })),
});
export type ExtrasOutput = z.infer<typeof ExtrasOutput>;

export function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export const fileOf = (fn: string): string => fn.slice(0, fn.indexOf("#"));

function dirOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
}

/** Longest folder that holds every file ("" when they only share the root). */
export function commonDir(files: string[]): string {
  if (files.length === 0) return "";
  let common = dirOf(files[0]!).split("/");
  for (const file of files.slice(1)) {
    const parts = dirOf(file).split("/");
    let i = 0;
    while (i < common.length && common[i] === parts[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.join("/");
}

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}~${n}`;
  taken.add(id);
  return id;
}

/**
 * `part:` + the files' common folder; when that folder is shared with an existing node (a parent or sibling) or is
 * the root, the most central file instead (D37). Collisions get `~2`, `~3`.
 */
export function partId(files: string[], taken: Set<string>, centralFile: (files: string[]) => string): string {
  const dir = commonDir(files);
  const byDir = files.length === 1 ? `part:${files[0]}` : `part:${dir}`;
  if (dir !== "" && !taken.has(byDir)) return unique(byDir, taken);
  return unique(`part:${centralFile(files)}`, taken);
}

/** `<parent>#<hash of cited functions>` (as D23's step ids). */
export function stepId(parent: string, functions: string[], taken: Set<string>): string {
  const hash = createHash("sha256").update(`${parent}\n${[...functions].sort().join("\n")}`).digest("hex").slice(0, 8);
  return unique(`${parent}#${hash}`, taken);
}

export const journeyId = (entry: string): string => `journey:${entry}`;
export const systemId = (name: string): string => `system:${name}`;

/** Same tree → same bytes: nodes sorted by id. */
export function sortedNodes(nodes: Record<string, UnderstandingNode>): Record<string, UnderstandingNode> {
  return Object.fromEntries(Object.entries(nodes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, node]) => [id, canonicalNode(node)]));
}
