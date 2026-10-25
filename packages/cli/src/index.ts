import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, buildCallTrees, computeSignals, type Signals, type Snapshot } from "@catchup/analyzer";
import { fileChurn } from "@catchup/history";
import {
  agentRunner,
  anthropicRunner,
  anthropicSession,
  buildDigest,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MODEL,
  droidRunner,
  explainSnapshot,
  openNode,
  providerFrom,
  selectTopFlows,
  understand,
  type Explained,
  type PassLog,
  type Provider,
  type Runner,
  type Understanding,
  type UnderstandInputs,
  type UnderstandStats,
} from "@catchup/agent";
import {
  loadExplained,
  loadFacts,
  loadSignals,
  loadSnapshot,
  loadUnderstanding,
  saveAnalysis,
  saveDigest,
  saveExplained,
  saveRun,
  saveSignals,
  saveUnderstanding,
  storePaths,
} from "@catchup/store";
import { startDashboard } from "@catchup/web";
import { formatTree } from "./tree.js";
import { formatUnderstanding } from "./understanding.js";

export const packageName = "cli";

export function usage(): string {
  return [
    "usage: catchup <command> [path]",
    "  init <path>                    analyze HEAD and save .catchup/ files",
    "  flow <path>                    list entry points (run init first)",
    '  flow <path> "<label>" [--all]  print one call tree, e.g. "POST /api/auth/login"',
    '  explain <path> ["<label>" …] [--top N]   Claude explains flows (default: top 15) and components',
    "  understand <path> [--max-calls N]        read-only Claude agents build the understanding tree",
    '  understand <path> --open "<node id>"     write the children of an unopened node',
    "  open <path> [--port N]         show the understanding tree in your browser (opening a box may call Claude)",
    "",
    "Claude is reached through Droid (FACTORY_API_KEY) by default; CATCHUP_PROVIDER=anthropic uses the Anthropic API (ANTHROPIC_API_KEY).",
  ].join("\n");
}

function headSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${repoRoot} is not a git repository with at least one commit`);
  }
}

/** Plain-text table of components, largest first. */
export function formatSummary(snapshot: Snapshot): string {
  const outgoing = new Map<string, string[]>();
  for (const edge of [...snapshot.edges].sort((a, b) => b.weight - a.weight)) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(`${edge.to} (${edge.weight})`);
    outgoing.set(edge.from, list);
  }
  const externalsOf = new Map<string, string[]>();
  for (const ext of snapshot.externals) {
    for (const id of ext.usedBy) externalsOf.set(id, [...(externalsOf.get(id) ?? []), ext.name]);
  }
  const rows = [...snapshot.components]
    .sort((a, b) => b.files.length - a.files.length || (a.id < b.id ? -1 : 1))
    .map((c) => [
      c.id,
      String(c.files.length),
      String(c.functionCount),
      (outgoing.get(c.id) ?? []).slice(0, 3).join(", "),
      (externalsOf.get(c.id) ?? []).join(", "),
    ]);
  const header = ["Component", "Files", "Functions", "Uses most", "External systems"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => (i === 1 || i === 2 ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  const externals = snapshot.externals.map((e) => `  ${e.name}: ${e.packages.join(", ")} ← ${e.usedBy.join(", ")}`);
  const { summary } = snapshot;
  return [
    line(header),
    ...rows.map(line),
    "",
    `External systems (${externals.length}):`,
    ...externals,
    "",
    `${summary.components} components, ${summary.files} files, ${summary.functions} functions, ${summary.imports} imports`,
  ].join("\n");
}

function readReadme(repoRoot: string): string | undefined {
  for (const name of ["README.md", "readme.md", "Readme.md", "README"]) {
    const path = join(repoRoot, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return undefined;
}

/** Files most flows run through, then most changed: where a reader should look first. */
export function formatHotFiles(signals: Signals, limit = 8): string {
  const rows = Object.entries(signals.files)
    .filter(([, s]) => s.flows > 0)
    .sort(([a, x], [b, y]) => y.flows - x.flows || y.churn - x.churn || (a < b ? -1 : 1))
    .slice(0, limit)
    .map(([path, s]) => `  ${path}  (${s.flows} flows, ${s.churn} commits${s.systems.length ? `, ${s.systems.join(", ")}` : ""})`);
  return [`Busiest files (${signals.families.length} flow families):`, ...rows].join("\n");
}

async function init(target: string): Promise<void> {
  const repoRoot = resolve(target);
  if (!existsSync(repoRoot)) throw new Error(`no such directory: ${repoRoot}`);
  const sha = headSha(repoRoot);
  const started = Date.now();
  const { facts, snapshot } = await analyze(repoRoot, sha);
  const paths = saveAnalysis(repoRoot, facts, snapshot);
  const signals = computeSignals({ facts, trees: buildCallTrees(facts, snapshot), churn: fileChurn(repoRoot, sha), readme: readReadme(repoRoot) });
  const signalsPath = saveSignals(repoRoot, signals);
  console.log(formatSummary(snapshot));
  console.log(`\n${formatHotFiles(signals)}`);
  console.log(`\nAnalyzed ${sha.slice(0, 9)} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`Saved ${relative(process.cwd(), paths.facts)}`);
  console.log(`Saved ${relative(process.cwd(), paths.snapshot)}`);
  console.log(`Saved ${relative(process.cwd(), signalsPath)}`);
  console.log(`${facts.entryPoints.length} entry points, ${facts.calls.length} calls; see them with: catchup flow ${target}`);
}

function loadAnalysis(target: string): { repoRoot: string; sha: string; facts: ReturnType<typeof loadFacts>; snapshot: Snapshot } {
  const repoRoot = resolve(target);
  const sha = headSha(repoRoot);
  if (!existsSync(storePaths(repoRoot, sha).facts)) throw new Error(`no analysis for ${sha.slice(0, 9)}; run: catchup init ${target}`);
  return { repoRoot, sha, facts: loadFacts(repoRoot, sha), snapshot: loadSnapshot(repoRoot, sha) };
}

function flow(target: string, label: string | undefined, showNoise: boolean): void {
  const { facts, snapshot } = loadAnalysis(target);
  const trees = buildCallTrees(facts, snapshot);
  if (label === undefined) {
    for (const tree of trees) {
      const status = tree.partial ? "partial" : "complete";
      console.log(`${tree.entryPoint.label.padEnd(60)} ${String(tree.functionCount).padStart(4)} fns  ${status.padEnd(8)}  ${tree.systems.join(", ")}`);
    }
    console.log(`\n${trees.length} entry points`);
    return;
  }
  const tree = trees.find((t) => t.entryPoint.label === label || t.entryPoint.id === label);
  if (!tree) throw new Error(`no entry point "${label}"; run: catchup flow ${target}`);
  const functions = new Map(facts.functions.map((fn) => [fn.id, fn]));
  console.log(formatTree(tree, { showNoise, functions }));
}

/** Text view of an explanation: areas, then each flow's steps. */
export function formatExplained(explained: Explained): string {
  const lines: string[] = [];
  const flows = new Map(explained.flows.map((f) => [f.id, f]));
  for (const area of explained.areas) {
    lines.push(`## ${area.name} — ${area.description}`);
    for (const id of area.flows) {
      const flow = flows.get(id);
      if (!flow) continue;
      lines.push(``, `${flow.label}${flow.partial ? "  (partial)" : ""}`);
      flow.steps.forEach((step, i) => {
        const tag = step.kind === "main" ? "" : ` [${step.kind}]`;
        lines.push(`  ${i + 1}. ${step.label}${tag} — ${step.summary}`);
        lines.push(`     ${step.functions.join(", ")}`);
      });
    }
    lines.push("");
  }
  lines.push("Components:", ...explained.components.map((c) => `  ${c.id}: ${c.name} — ${c.description}`));
  return lines.join("\n");
}

/** Loads `.env` and checks the credentials of the chosen provider (D51): `CATCHUP_PROVIDER=droid` (default) or `anthropic`. */
function loadEnv(): Provider {
  const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const provider = providerFrom(process.env.CATCHUP_PROVIDER);
  if (provider === "droid" && !process.env.FACTORY_API_KEY) throw new Error("FACTORY_API_KEY is not set (put it in .env at the Catchup repo root, or set CATCHUP_PROVIDER=anthropic)");
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY is not set (put it in .env at the Catchup repo root, or set CATCHUP_PROVIDER=droid)");
  }
  return provider;
}

/** A no-tools structured runner for the chosen provider. */
function structuredRunner(provider: Provider, cwd: string, model: string): Runner {
  return provider === "anthropic" ? anthropicRunner({ model }) : droidRunner({ cwd, model });
}

async function explain(target: string, labels: string[], top: number): Promise<void> {
  const provider = loadEnv();
  const { repoRoot, sha, facts, snapshot } = loadAnalysis(target);
  const trees = buildCallTrees(facts, snapshot);
  const previous = loadExplained<Explained>(repoRoot, sha);
  const byLabel = new Map(trees.map((t) => [t.entryPoint.label, t]));
  const missing = labels.filter((l) => !byLabel.has(l));
  if (missing.length) throw new Error(`no entry point: ${missing.join(", ")}; run: catchup flow ${target}`);
  const wanted = new Set(labels.length ? labels : selectTopFlows(trees, top).map((t) => t.entryPoint.label));
  for (const flow of previous?.flows ?? []) wanted.add(flow.label);
  const selected = trees.filter((t) => wanted.has(t.entryPoint.label));
  const model = process.env.CATCHUP_MODEL ?? DEFAULT_MODEL;
  const started = Date.now();
  const { explained, stats } = await explainSnapshot({
    facts,
    snapshot,
    trees: selected,
    allTrees: trees,
    previous,
    runner: structuredRunner(provider, repoRoot, model),
    model,
    readFile: (path) => {
      try {
        return readFileSync(join(repoRoot, path), "utf8");
      } catch {
        return undefined;
      }
    },
    onCall: (job, attempt) => console.error(`  claude (${model} via ${provider}): ${job}${attempt > 1 ? " (retry)" : ""}`),
    onRejected: (job, problems) => console.error(`  validator rejected ${job}:\n${problems.map((p) => `    - ${p}`).join("\n")}`),
  });
  const path = saveExplained(repoRoot, explained);
  console.log(formatExplained(explained));
  console.log(
    `\n${explained.flows.length} flows (${stats.newFlows} new, ${stats.updatedFlows} updated, ${stats.carriedFlows} unchanged), ` +
      `${stats.claudeJobs} Claude calls, ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  console.log(`Saved ${relative(process.cwd(), path)}`);
}

function readPackageJson(repoRoot: string): string | undefined {
  const path = join(repoRoot, "package.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

type UnderstandOptions = { open?: string; maxCalls: number };

type Workspace = {
  repoRoot: string;
  sha: string;
  facts: ReturnType<typeof loadFacts>;
  snapshot: Snapshot;
  trees: ReturnType<typeof buildCallTrees>;
  signals: Signals;
};

function workspace(target: string): Workspace {
  const { repoRoot, sha, facts, snapshot } = loadAnalysis(target);
  const trees = buildCallTrees(facts, snapshot);
  const signals = loadSignals(repoRoot, sha) ?? computeSignals({ facts, trees, churn: fileChurn(repoRoot, sha), readme: readReadme(repoRoot) });
  return { repoRoot, sha, facts, snapshot, trees, signals };
}

type Session = {
  inputs: (previous: Understanding | undefined) => UnderstandInputs;
  toolCalls: () => number;
  /** Writes the run log; returns its path. */
  finish: (command: string, stats: UnderstandStats | undefined) => string;
};

/** Everything one Understand or Open run needs, and its run log (D38). */
function understandSession(ws: Workspace, provider: Provider, maxCalls: number, startedAt: Date, quiet = false): Session {
  const { repoRoot, sha, facts, snapshot, trees, signals } = ws;
  const readFile = (path: string): string | undefined => {
    try {
      return readFileSync(join(repoRoot, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const digest = buildDigest({ facts, snapshot, signals, trees, readme: readReadme(repoRoot), packageJson: readPackageJson(repoRoot), readFile });
  const digestDir = saveDigest(repoRoot, sha, digest.files);
  const model = process.env.CATCHUP_MODEL ?? DEFAULT_MODEL;
  const passes: PassLog[] = [];
  const say = (line: string): void => {
    if (!quiet) console.error(line);
  };
  const toolCalls = (): number => passes.reduce((n, p) => n + p.toolCalls.length, 0);
  return {
    toolCalls,
    inputs: (previous) => ({
      facts,
      snapshot,
      signals,
      trees,
      digest: digest.files,
      digestDir,
      maxToolCalls: maxCalls,
      readFile,
      model,
      previous,
      runnerFor: (pass) =>
        agentRunner({
          pass,
          cwd: repoRoot,
          roots: [digestDir],
          model,
          maxToolCalls: maxCalls,
          ...(provider === "anthropic" ? { open: anthropicSession() } : {}),
          log: (entry) => passes.push(entry),
        }),
      onCall: (job, attempt) => say(`  claude (${model} via ${provider}): ${job}${attempt > 1 ? " (retry)" : ""}`),
      onRejected: (job, problems) => say(`  validator rejected ${job}:\n${problems.map((p) => `    - ${p}`).join("\n")}`),
      onProgress: (partial) => saveUnderstanding(repoRoot, partial),
    }),
    finish: (command, stats) => {
      const tokens = passes.reduce((sum, p) => sum + (p.tokens ? p.tokens.input + p.tokens.output + p.tokens.cacheRead + p.tokens.cacheCreation : 0), 0);
      const run = {
        sha,
        command,
        provider,
        model,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        claudeCalls: passes.length,
        toolCalls: toolCalls(),
        tokens,
        ...(stats ? { stats } : { failed: true }),
        passes,
      };
      return saveRun(repoRoot, startedAt, run);
    },
  };
}

/** Builds (or extends) the understanding tree with read-only Claude agents (Build 2). */
async function understandCommand(target: string, options: UnderstandOptions): Promise<void> {
  const provider = loadEnv();
  const ws = workspace(target);
  const startedAt = new Date();
  const session = understandSession(ws, provider, options.maxCalls, startedAt);
  const previous = loadUnderstanding<Understanding>(ws.repoRoot, ws.sha);
  const inputs = session.inputs(previous);
  let stats: UnderstandStats | undefined;
  try {
    let result: { understanding: Understanding; stats: UnderstandStats };
    if (options.open !== undefined) {
      if (!previous) throw new Error(`no understanding for ${ws.sha.slice(0, 9)} yet; run: catchup understand ${target}`);
      result = await openNode(inputs, previous, options.open);
    } else {
      result = await understand(inputs);
    }
    stats = result.stats;
    const path = saveUnderstanding(ws.repoRoot, result.understanding);
    console.log(formatUnderstanding(result.understanding));
    console.log(
      `\n${stats.calls} Claude calls (${stats.passes} passes run, ${stats.carried} unchanged), ` +
        `${session.toolCalls()} tool calls, ${((Date.now() - startedAt.getTime()) / 1000).toFixed(0)} s`,
    );
    console.log(`Saved ${relative(process.cwd(), path)}`);
  } finally {
    const log = session.finish(options.open !== undefined ? `understand --open ${options.open}` : "understand", stats);
    console.error(`Run log: ${relative(process.cwd(), log)}`);
  }
}

/** The Open pass behind the dashboard's "open" clicks: one run log per open, the tree saved after each. */
function openFromDashboard(ws: Workspace, maxCalls: number): (understanding: Understanding, id: string) => Promise<Understanding> {
  return async (understanding, id) => {
    const provider = loadEnv();
    const startedAt = new Date();
    const session = understandSession(ws, provider, maxCalls, startedAt, true);
    let stats: UnderstandStats | undefined;
    try {
      const result = await openNode(session.inputs(understanding), understanding, id);
      stats = result.stats;
      saveUnderstanding(ws.repoRoot, result.understanding);
      console.log(`  opened ${id}: ${stats.calls} Claude call${stats.calls === 1 ? "" : "s"}, ${((Date.now() - startedAt.getTime()) / 1000).toFixed(0)} s`);
      return result.understanding;
    } finally {
      session.finish(`open ${id}`, stats);
    }
  };
}

async function open(target: string, port: number, maxCalls: number): Promise<void> {
  const ws = workspace(target);
  const understanding = loadUnderstanding<Understanding>(ws.repoRoot, ws.sha);
  const { url } = await startDashboard({ ...ws, ...(understanding ? { understanding } : {}), open: openFromDashboard(ws, maxCalls) }, port);
  console.log(`Catchup dashboard: ${url}`);
  if (!understanding) console.log(`(no understanding yet; run: catchup understand ${target})`);
  console.log("Press Ctrl+C to stop.");
}

function option(argv: string[], name: string): { value: string | undefined; rest: string[] } {
  const at = argv.indexOf(name);
  if (at === -1) return { value: undefined, rest: argv };
  return { value: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

export async function main(argvIn: string[]): Promise<number> {
  const { value: portValue, rest: afterPort } = option(argvIn, "--port");
  const { value: topValue, rest: afterTop } = option(afterPort, "--top");
  const { value: openValue, rest: afterOpen } = option(afterTop, "--open");
  const { value: maxCallsValue, rest: argv } = option(afterOpen, "--max-calls");
  const showNoise = argv.includes("--all");
  const [command, target = ".", label, ...more] = argv.filter((arg) => arg !== "--all");
  if (command === "explain") {
    const top = topValue === undefined ? 15 : Number(topValue);
    if (!Number.isInteger(top) || top < 1) throw new Error("--top needs a positive number");
    await explain(target, [label, ...more].filter((l): l is string => l !== undefined), top);
    return 0;
  }
  if (command === "understand") {
    const maxCalls = maxCallsValue === undefined ? DEFAULT_MAX_TOOL_CALLS : Number(maxCallsValue);
    if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error("--max-calls needs a number ≥ 0");
    await understandCommand(target, { ...(openValue !== undefined ? { open: openValue } : {}), maxCalls });
    return 0;
  }
  if (command === "open") {
    const port = portValue === undefined ? 5173 : Number(portValue);
    if (!Number.isInteger(port) || port < 1) throw new Error("--port needs a positive number");
    const maxCalls = maxCallsValue === undefined ? DEFAULT_MAX_TOOL_CALLS : Number(maxCallsValue);
    if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error("--max-calls needs a number ≥ 0");
    await open(target, port, maxCalls);
    return 0;
  }
  if (command === "init") {
    await init(target);
    return 0;
  }
  if (command === "flow") {
    flow(target, label, showNoise);
    return 0;
  }
  console.error(usage());
  return 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (process.argv[2] !== "open" || code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
