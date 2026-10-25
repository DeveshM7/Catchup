import { createHash } from "node:crypto";
import type { CallTree, Facts, Signals, Snapshot } from "@catchup/analyzer";
import { renderSnippets, renderTree, treeFunctions, type BriefInputs } from "./brief.js";
import { readmeExcerpt, toolFunctions } from "./overview.js";
import { LEGEND } from "./prompts.js";

/** Journey candidates that get a `flow-<id>.md` digest: the top flow families' representatives. */
export const JOURNEY_CANDIDATES = 6;
const HOT_FUNCTIONS = 30;
const HOT_FILES = 20;
const TREE_DEPTH = 3;

export type DigestInputs = {
  facts: Facts;
  snapshot: Snapshot;
  signals: Signals;
  trees: CallTree[];
  readme?: string;
  /** Raw package.json at the repo root. */
  packageJson?: string;
  readFile: (path: string) => string | undefined;
};

export type Digest = {
  /** file name → markdown, written to `.catchup/digest/<sha>/`. */
  files: Record<string, string>;
  /** Entry point ids with a flow digest, best family first. */
  candidates: string[];
};

/** File name of an entry point's flow digest: readable slug + short hash (ids hold `/`, `:` and spaces). */
export function flowDigestName(entryId: string): string {
  const slug = entryId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const hash = createHash("sha256").update(entryId).digest("hex").slice(0, 6);
  return `flow-${slug}-${hash}.md`;
}

function packageLines(raw: string | undefined): string[] {
  if (!raw) return ["(no package.json at the root)"];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return ["(package.json does not parse)"];
  }
  const keys = (v: unknown): string => (v && typeof v === "object" ? Object.keys(v).sort().join(", ") : "");
  return [
    `- name: ${typeof pkg.name === "string" ? pkg.name : "(none)"}`,
    typeof pkg.description === "string" ? `- description: ${pkg.description}` : "",
    keys(pkg.scripts) ? `- scripts: ${keys(pkg.scripts)}` : "",
    keys(pkg.dependencies) ? `- dependencies: ${keys(pkg.dependencies)}` : "",
    keys(pkg.devDependencies) ? `- devDependencies: ${keys(pkg.devDependencies)}` : "",
    pkg.bin ? `- bin: ${typeof pkg.bin === "string" ? pkg.bin : keys(pkg.bin)}` : "",
  ].filter(Boolean);
}

/** Folder tree with file counts; folders deeper than `TREE_DEPTH` are folded into their parent's count. */
export function folderTree(paths: string[]): string[] {
  const counts = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.length === 1) rootFiles.push(path);
    for (let depth = 1; depth < parts.length && depth <= TREE_DEPTH; depth += 1) {
      const dir = parts.slice(0, depth).join("/");
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  const lines = [...counts.keys()].sort().map((dir) => {
    const depth = dir.split("/").length - 1;
    return `${"  ".repeat(depth)}- ${dir.slice(dir.lastIndexOf("/") + 1)}/ (${counts.get(dir)} files)`;
  });
  return [...lines, ...rootFiles.sort().map((f) => `- ${f}`)];
}

function repoDigest(inputs: DigestInputs): string {
  const { snapshot } = inputs;
  return [
    "# Repository",
    "",
    "## package.json",
    ...packageLines(inputs.packageJson),
    "",
    "## README (excerpt)",
    readmeExcerpt(inputs.readme) || "(none)",
    "",
    `## Folders (${inputs.facts.files.length} source files)`,
    ...folderTree(inputs.facts.files.map((f) => f.path)),
    "",
    "## Components (folders grouped by code, D19; a starting point, not the final parts)",
    ...snapshot.components.map((c) => `- ${c.id}: ${c.files.length} files, ${c.functionCount} functions${c.packages.length ? `; packages: ${c.packages.slice(0, 8).join(", ")}` : ""}`),
    "",
    "## Outside systems and tools",
    ...(snapshot.externals.length
      ? snapshot.externals.map((e) => `- ${e.name}${e.kind === "tool" ? " (tool)" : ""}: ${e.packages.join(", ")} (used by ${e.usedBy.join(", ")})`)
      : ["(none)"]),
  ].join("\n");
}

function entriesDigest(inputs: DigestInputs): string {
  const trees = new Map(inputs.trees.map((t) => [t.entryPoint.id, t]));
  const line = (id: string): string => {
    const tree = trees.get(id);
    if (!tree) return `- ${id}`;
    const e = tree.entryPoint;
    const systems = tree.systems.length ? `; systems: ${tree.systems.join(", ")}` : "";
    return `- \`${e.id}\` (${e.kind}) ${e.label} — handler [${e.handler}], ${tree.functionCount} functions${systems}${tree.partial ? "; partial" : ""}`;
  };
  const inFamily = new Set(inputs.signals.families.flatMap((f) => f.members));
  const screens = inputs.trees.filter((t) => !inFamily.has(t.entryPoint.id)).map((t) => t.entryPoint.id);
  return [
    "# Entry points",
    "",
    "Grouped into flow families: entry points whose call trees share most of their code (D32). Families are ranked by how much they touch (files, systems, components); the first ones are usually the main journeys.",
    `A \`ui:\` entry point's tree continues into the server through \`request →\` calls, so it covers the whole journey from the browser to the database and back.`,
    "",
    ...inputs.signals.families.flatMap((family) => [
      `## \`${family.id}\` (score ${family.score}, ${family.members.length} entry point${family.members.length === 1 ? "" : "s"}${family.systems.length ? `, ${family.systems.join(", ")}` : ""})`,
      ...family.members.map(line),
      "",
    ]),
    "## Screens and other entry points (not in a family)",
    ...(screens.length ? screens.map(line) : ["(none)"]),
  ].join("\n");
}

function hotDigest(inputs: DigestInputs): string {
  const { signals } = inputs;
  const reasons = (s: { flows: number; fanIn: number; systems: string[]; readme: boolean }): string =>
    [
      `${s.flows} flows`,
      `fan-in ${s.fanIn}`,
      s.systems.length ? `calls ${s.systems.join(", ")}` : "",
      s.readme ? "in README" : "",
    ]
      .filter(Boolean)
      .join(", ");
  const functions = Object.entries(signals.functions)
    .filter(([, s]) => s.flows > 0 || s.fanIn >= 3)
    .sort(([a, x], [b, y]) => y.flows - x.flows || y.fanIn - x.fanIn || (a < b ? -1 : 1))
    .slice(0, HOT_FUNCTIONS)
    .map(([id, s]) => `- [${id}] — ${reasons(s)}${s.exported ? ", exported" : ""}`);
  const files = Object.entries(signals.files)
    .sort(([a, x], [b, y]) => y.flows - x.flows || y.churn - x.churn || (a < b ? -1 : 1))
    .slice(0, HOT_FILES)
    .map(([path, s]) => `- ${path} — ${reasons(s)}, ${s.churn} commits${s.lastChanged ? `, last ${s.lastChanged.slice(0, 10)}` : ""}${s.side ? `, ${s.side}` : ""}`);
  return ["# Hot spots", "", "Ranked by code signals: how many flows reach it, how many callers, outside systems.", "", "## Functions", ...functions, "", "## Files", ...files].join("\n");
}

function filesDigest(inputs: DigestInputs): string {
  const fnCount = new Map<string, number>();
  for (const fn of inputs.facts.functions) fnCount.set(fn.file, (fnCount.get(fn.file) ?? 0) + 1);
  return [
    "# Source files",
    "",
    "Every source file in scope, with lines, functions, side (client / server / shared) and how many flows reach it.",
    "",
    ...inputs.facts.files.map((f) => {
      const s = inputs.signals.files[f.path];
      return `- ${f.path} — ${f.loc} lines, ${fnCount.get(f.path) ?? 0} functions${f.side ? `, ${f.side}` : ""}${s && s.flows ? `, ${s.flows} flows` : ""}`;
    }),
  ].join("\n");
}

/** The call tree and key source of one journey candidate. */
export function flowDigest(tree: CallTree, brief: BriefInputs): string {
  const tools = toolFunctions(tree);
  const files = new Set([...treeFunctions(tree)].map((fn) => fn.slice(0, fn.indexOf("#"))));
  return [
    `# Flow \`${tree.entryPoint.id}\``,
    "",
    `Entry point: ${tree.entryPoint.label} (${tree.entryPoint.kind}), handler [${tree.entryPoint.handler}] in ${tree.entryPoint.file}`,
    `Reaches ${tree.functionCount} functions in ${files.size} files. Outside systems: ${tree.systems.join(", ") || "none"}${tree.partial ? ". Some calls are only known at runtime (?)." : ""}`,
    tools.length ? `AI tools the model can call: ${tools.map((t) => `[${t}]`).join(", ")}` : "",
    "",
    `## Call tree`,
    LEGEND,
    "",
    renderTree(tree, brief),
    "",
    "## Source of the key functions",
    renderSnippets(tree, brief) || "(none)",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

/** Readable markdown the agent starts from (ARCHITECTURE §5); deterministic. */
export function buildDigest(inputs: DigestInputs): Digest {
  const trees = new Map(inputs.trees.map((t) => [t.entryPoint.id, t]));
  const brief: BriefInputs = { functions: new Map(inputs.facts.functions.map((fn) => [fn.id, fn])), readFile: inputs.readFile };
  const candidates = inputs.signals.families
    .slice(0, JOURNEY_CANDIDATES)
    .map((f) => f.representative)
    .filter((id) => trees.has(id));
  const files: Record<string, string> = {
    "repo.md": repoDigest(inputs),
    "entries.md": entriesDigest(inputs),
    "hot.md": hotDigest(inputs),
    "files.md": filesDigest(inputs),
  };
  for (const id of candidates) files[flowDigestName(id)] = flowDigest(trees.get(id)!, brief);
  return { files, candidates };
}
