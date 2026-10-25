import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCallTrees, type Signals, type Snapshot } from "@catchup/analyzer";
import { commitsBetween, renamesBetween } from "@catchup/history";
import {
  agentRunner,
  anthropicRunner,
  askQuestion,
  anthropicSession,
  buildDigest,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MODEL,
  droidRunner,
  evolve,
  explainSnapshot,
  formatChanges,
  openNode,
  providerFrom,
  selectTopFlows,
  understand,
  type Explained,
  type Answer,
  type ChangeContext,
  type PassLog,
  type ToolCallLog,
  type Provider,
  type Runner,
  type Understanding,
  type UnderstandInputs,
  type UnderstandStats,
} from "@catchup/agent";
import { loadExplained, loadFacts, loadSnapshot, loadUnderstanding, saveDigest, saveExplained, saveRun, saveUnderstanding, storePaths } from "@catchup/store";
import { startDashboard } from "@catchup/web";
import { analyzeAt, ancestorWithTree, changeSet, headSha, loadWorkspace, readReadme, resolveCommit, withCode, workspaceAt, type Workspace } from "./commits.js";
import { runTimelapse } from "./timelapse.js";
import { formatTree } from "./tree.js";
import { formatUnderstanding } from "./understanding.js";

export const packageName = "cli";

export function usage(): string {
  return [
    "usage: catchup <command> [path]",
    "  init <path> [--at <ref>]       analyze HEAD (or a commit, in a worktree) and save .catchup/ files",
    "  flow <path>                    list entry points (run init first)",
    '  flow <path> "<label>" [--all]  print one call tree, e.g. "POST /api/auth/login"',
    '  explain <path> ["<label>" …] [--top N]   Claude explains flows (default: top 15) and components',
    "  understand <path> [--max-calls N]        read-only Claude agents build the understanding tree",
    "  understand <path> --at <ref> [--from <ref>]   the tree at a commit, evolved from an earlier tree (edit, don't regenerate)",
    "  diff <path> <from> <to>        what changed between two commits with trees (files, entry points, systems, boxes, journeys)",
    "  timelapse <path> [--from <ref>] [--to <ref>] [--count N]   trees at ~N checkpoints, captioned, played in the dashboard",
    '  understand <path> --open "<node id>"     write the children of an unopened node',
    "  open <path> [--port N]         show the understanding tree in your browser (opening a box or asking calls Claude)",
    '  ask <path> "<question>" [--node "<node id>"] [--changes <from>..<to>]   ask a read-only agent; answers cite real code (and commits)',
    "",
    "Claude is reached through Droid (FACTORY_API_KEY) by default; CATCHUP_PROVIDER=anthropic uses the Anthropic API (ANTHROPIC_API_KEY).",
  ].join("\n");
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

/** Files most flows run through, then most changed: where a reader should look first. */
export function formatHotFiles(signals: Signals, limit = 8): string {
  const rows = Object.entries(signals.files)
    .filter(([, s]) => s.flows > 0)
    .sort(([a, x], [b, y]) => y.flows - x.flows || y.churn - x.churn || (a < b ? -1 : 1))
    .slice(0, limit)
    .map(([path, s]) => `  ${path}  (${s.flows} flows, ${s.churn} commits${s.systems.length ? `, ${s.systems.join(", ")}` : ""})`);
  return [`Busiest files (${signals.families.length} flow families):`, ...rows].join("\n");
}

function repoOf(target: string): string {
  const repoRoot = resolve(target);
  if (!existsSync(repoRoot)) throw new Error(`no such directory: ${repoRoot}`);
  return repoRoot;
}

async function init(target: string, at: string | undefined): Promise<void> {
  const repoRoot = repoOf(target);
  const sha = at === undefined ? headSha(repoRoot) : resolveCommit(repoRoot, at);
  const started = Date.now();
  const { facts, snapshot, signals } = await withCode(repoRoot, sha, (dir) => analyzeAt(repoRoot, dir, sha));
  const paths = storePaths(repoRoot, sha);
  console.log(formatSummary(snapshot));
  console.log(`\n${formatHotFiles(signals)}`);
  console.log(`\nAnalyzed ${sha.slice(0, 9)} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const path of [paths.facts, paths.snapshot, paths.signals]) console.log(`Saved ${relative(process.cwd(), path)}`);
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

type UnderstandOptions = { open?: string; maxCalls: number; at?: string; from?: string };

/** The stored analysis of HEAD, read in place. */
function workspace(target: string): Workspace {
  const repoRoot = repoOf(target);
  const sha = headSha(repoRoot);
  const ws = loadWorkspace(repoRoot, repoRoot, sha);
  if (!ws) throw new Error(`no analysis for ${sha.slice(0, 9)}; run: catchup init ${target}`);
  return ws;
}

type Session = {
  inputs: (previous: Understanding | undefined) => UnderstandInputs;
  toolCalls: () => number;
  /** Writes the run log; returns its path. `stats` absent = the run failed. */
  finish: (command: string, stats: object | undefined) => string;
};

/** Everything one Understand or Open run needs, and its run log (D38). */
function understandSession(ws: Workspace, provider: Provider, maxCalls: number, startedAt: Date, quiet = false, onTool?: (call: ToolCallLog) => void): Session {
  const { repoRoot, dir, sha, facts, snapshot, trees, signals } = ws;
  // Code is read where it is checked out (a worktree for older commits); results are stored in the repo.
  const readFile = (path: string): string | undefined => {
    try {
      return readFileSync(join(dir, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const digest = buildDigest({ facts, snapshot, signals, trees, readme: readReadme(dir), packageJson: readPackageJson(dir), readFile });
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
          cwd: dir,
          roots: [digestDir],
          model,
          maxToolCalls: maxCalls,
          ...(provider === "anthropic" ? { open: anthropicSession() } : {}),
          ...(onTool ? { onTool } : {}),
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

/**
 * The tree at one commit (Builds 2 and 6): carried forward when it exists, evolved from an earlier commit's tree when one
 * exists (edit, don't regenerate, D4), else written from scratch. Returns the tree and the change set when it evolved.
 */
export async function treeAt(repoRoot: string, sha: string, options: { maxCalls: number; from?: string; fresh?: boolean; open?: string; quiet?: boolean }): Promise<{ understanding: Understanding; evolvedFrom?: string }> {
  const provider = loadEnv();
  return withCode(repoRoot, sha, async (dir) => {
    const ws = await workspaceAt(repoRoot, dir, sha);
    const startedAt = new Date();
    const session = understandSession(ws, provider, options.maxCalls, startedAt, options.quiet);
    // Fresh: write this commit's tree from scratch, whatever is stored for it.
    const previous = options.fresh ? undefined : loadUnderstanding<Understanding>(repoRoot, sha);
    const inputs = session.inputs(previous);
    const from = previous || options.open !== undefined || options.fresh ? undefined : (options.from ?? ancestorWithTree(repoRoot, sha));
    let stats: UnderstandStats | undefined;
    let command = options.open !== undefined ? `understand --open ${options.open}` : "understand";
    try {
      let result: { understanding: Understanding; stats: UnderstandStats };
      if (options.open !== undefined) {
        if (!previous) throw new Error(`no understanding for ${sha.slice(0, 9)} yet; run: catchup understand <path>`);
        result = await openNode(inputs, previous, options.open);
      } else if (from !== undefined) {
        const base = loadUnderstanding<Understanding>(repoRoot, from);
        if (!base) throw new Error(`no understanding for ${from.slice(0, 9)} to evolve from`);
        command = `understand --from ${from.slice(0, 9)}`;
        result = await evolve({ ...inputs, from: { understanding: base, facts: loadFacts(repoRoot, from) }, renames: renamesBetween(repoRoot, from, sha) });
      } else {
        result = await understand(inputs);
      }
      stats = result.stats;
      saveUnderstanding(repoRoot, result.understanding);
      if (!options.quiet) {
        console.log(formatUnderstanding(result.understanding));
        console.log(
          `\n${stats.calls} Claude calls (${stats.passes} passes run, ${stats.carried} unchanged), ` +
            `${session.toolCalls()} tool calls, ${((Date.now() - startedAt.getTime()) / 1000).toFixed(0)} s`,
        );
      }
      return { understanding: result.understanding, ...(from !== undefined ? { evolvedFrom: from } : {}) };
    } finally {
      const log = session.finish(command, stats);
      if (!options.quiet) console.error(`Run log: ${relative(process.cwd(), log)}`);
    }
  });
}

/** Builds (or extends) the understanding tree with read-only Claude agents (Builds 2, 6). */
async function understandCommand(target: string, options: UnderstandOptions): Promise<void> {
  const repoRoot = repoOf(target);
  const sha = options.at === undefined ? headSha(repoRoot) : resolveCommit(repoRoot, options.at);
  const from = options.from === undefined ? undefined : resolveCommit(repoRoot, options.from);
  const result = await treeAt(repoRoot, sha, { maxCalls: options.maxCalls, ...(from ? { from } : {}), ...(options.open !== undefined ? { open: options.open } : {}) });
  console.log(`Saved ${relative(process.cwd(), storePaths(repoRoot, sha).understanding)}`);
  if (result.evolvedFrom !== undefined) {
    console.log(`\nChanges since ${result.evolvedFrom.slice(0, 9)}:\n${formatChanges(changeSet(repoRoot, result.evolvedFrom, sha))}`);
  }
}

/** Builds (or rebuilds from stored pieces) a timelapse A → B and saves it for the dashboard (Build 9). */
async function timelapseCommand(target: string, fromRef: string | undefined, toRef: string | undefined, count: number, maxCalls: number): Promise<void> {
  const repoRoot = repoOf(target);
  const provider = loadEnv();
  const model = process.env.CATCHUP_MODEL ?? DEFAULT_MODEL;
  const started = Date.now();
  const view = await runTimelapse(repoRoot, {
    ...(fromRef ? { from: resolveCommit(repoRoot, fromRef) } : {}),
    to: resolveCommit(repoRoot, toRef ?? "HEAD"),
    count,
    maxCalls,
    treeAt,
    captionRunner: structuredRunner(provider, repoRoot, model),
    say: (line) => console.log(line),
  });
  console.log(`\nTimelapse ${view.from.slice(0, 9)} → ${view.to.slice(0, 9)}: ${view.frames.length} frames, ${view.layout.nodes.length} boxes in the union layout, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  console.log(`Play it with: catchup open ${target} (Timelapse tab)`);
}

/** Prints (and saves) what changed between two commits that have trees (Build 6). */
function diff(target: string, fromRef: string | undefined, toRef: string | undefined): void {
  if (fromRef === undefined || toRef === undefined) throw new Error("usage: catchup diff <path> <from> <to>");
  const repoRoot = repoOf(target);
  console.log(formatChanges(changeSet(repoRoot, resolveCommit(repoRoot, fromRef), resolveCommit(repoRoot, toRef))));
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

type AskOptions = { node?: string; history?: { question: string; answer: string }[]; changes?: ChangeContext };

/** One Ask run (Build 5): a read-only agent answers with checked cites; logged like any pass (D38). */
async function runAsk(ws: Workspace, understanding: Understanding, question: string, options: AskOptions, maxCalls: number, onTool?: (call: ToolCallLog) => void): Promise<Answer> {
  const provider = loadEnv();
  const startedAt = new Date();
  const session = understandSession(ws, provider, maxCalls, startedAt, true, onTool);
  const inputs = session.inputs(understanding);
  let answer: Answer | undefined;
  try {
    answer = await askQuestion({
      facts: ws.facts,
      understanding,
      question,
      ...options,
      digestDir: inputs.digestDir,
      digestNames: Object.keys(inputs.digest).sort(),
      maxToolCalls: maxCalls,
      runner: inputs.runnerFor("ask"),
    });
    return answer;
  } finally {
    session.finish(`ask ${JSON.stringify(question)}`, answer ? { question, ...options, answer } : undefined);
  }
}

async function askCommand(target: string, question: string, node: string | undefined, range: string | undefined, maxCalls: number): Promise<void> {
  const ws = workspace(target);
  const understanding = loadUnderstanding<Understanding>(ws.repoRoot, ws.sha);
  if (!understanding) throw new Error(`no understanding for ${ws.sha.slice(0, 9)} yet; run: catchup understand ${target}`);
  let changes: ChangeContext | undefined;
  if (range !== undefined) {
    const [fromRef, toRef] = range.split("..");
    if (!fromRef || !toRef) throw new Error("--changes needs <from>..<to>");
    const from = resolveCommit(ws.repoRoot, fromRef);
    const to = resolveCommit(ws.repoRoot, toRef);
    const commits = commitsBetween(ws.repoRoot, from, to).map(({ sha, date, subject }) => ({ sha, date, subject }));
    changes = { label: `${from.slice(0, 7)} → ${to.slice(0, 7)}`, changes: changeSet(ws.repoRoot, from, to), commits };
  }
  const answer = await runAsk(ws, understanding, question, { ...(node ? { node } : {}), ...(changes ? { changes } : {}) }, maxCalls, (call) =>
    console.error(`  ${call.denied ? "denied" : "tool"}: ${call.name} ${call.target}`),
  );
  console.log(answer.answer);
  console.log(["", "Cites:", ...[...answer.nodes, ...answer.functions, ...answer.files, ...answer.commits.map((c) => `commit ${c.slice(0, 9)}`)].map((c) => `  - ${c}`)].join("\n"));
}

async function open(target: string, port: number, maxCalls: number): Promise<void> {
  const ws = workspace(target);
  const understanding = loadUnderstanding<Understanding>(ws.repoRoot, ws.sha);
  const ask = (u: Understanding, request: { question: string; node?: string; history?: AskOptions["history"] }, onStep: (call: ToolCallLog) => void, context?: ChangeContext): Promise<Answer> => {
    const { question, node, history } = request;
    return runAsk(ws, u, question, { ...(node ? { node } : {}), ...(history ? { history } : {}), ...(context ? { changes: context } : {}) }, maxCalls, onStep);
  };
  const { url } = await startDashboard({ ...ws, ...(understanding ? { understanding } : {}), open: openFromDashboard(ws, maxCalls), ask }, { port, preview: true });
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
  const { value: maxCallsValue, rest: afterMax } = option(afterOpen, "--max-calls");
  const { value: nodeValue, rest: afterNode } = option(afterMax, "--node");
  const { value: atValue, rest: afterAt } = option(afterNode, "--at");
  const { value: fromValue, rest: afterFrom } = option(afterAt, "--from");
  const { value: changesValue, rest: afterChanges } = option(afterFrom, "--changes");
  const { value: toValue, rest: afterTo } = option(afterChanges, "--to");
  const { value: countValue, rest: argv } = option(afterTo, "--count");
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
    await understandCommand(target, { ...(openValue !== undefined ? { open: openValue } : {}), ...(atValue ? { at: atValue } : {}), ...(fromValue ? { from: fromValue } : {}), maxCalls });
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
  if (command === "ask") {
    if (label === undefined) throw new Error('usage: catchup ask <path> "<question>" [--node "<node id>"]');
    const maxCalls = maxCallsValue === undefined ? DEFAULT_MAX_TOOL_CALLS : Number(maxCallsValue);
    if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error("--max-calls needs a number ≥ 0");
    await askCommand(target, [label, ...more].join(" "), nodeValue, changesValue, maxCalls);
    return 0;
  }
  if (command === "init") {
    await init(target, atValue);
    return 0;
  }
  if (command === "timelapse") {
    const count = countValue === undefined ? 15 : Number(countValue);
    if (!Number.isInteger(count) || count < 2) throw new Error("--count needs a number ≥ 2");
    const maxCalls = maxCallsValue === undefined ? DEFAULT_MAX_TOOL_CALLS : Number(maxCallsValue);
    await timelapseCommand(target, fromValue, toValue, count, maxCalls);
    return 0;
  }
  if (command === "diff") {
    diff(target, label, more[0]);
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
