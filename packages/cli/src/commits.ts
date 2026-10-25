import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, buildCallTrees, computeSignals, type CallTree, type Facts, type Signals, type Snapshot } from "@catchup/analyzer";
import { diffTrees, type ChangeSet, type Understanding } from "@catchup/agent";
import { commitInfo, fileChurn, renamesBetween, resolveCommit, withWorktree } from "@catchup/history";
import { CATCHUP_DIR, loadFacts, loadSignals, loadSnapshot, loadUnderstanding, saveAnalysis, saveChanges, saveSignals, storePaths } from "@catchup/store";

/** Where a commit's code is read from and its analysis is stored (Build 6). */
export type Workspace = {
  /** The repository; `.catchup/` lives here. */
  repoRoot: string;
  /** The code at `sha`: the repo itself for HEAD, else a temporary worktree. */
  dir: string;
  sha: string;
  facts: Facts;
  snapshot: Snapshot;
  trees: CallTree[];
  signals: Signals;
};

export function headSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${repoRoot} is not a git repository with at least one commit`);
  }
}

export function readReadme(dir: string): string | undefined {
  for (const name of ["README.md", "readme.md", "Readme.md", "README"]) {
    const path = join(dir, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return undefined;
}

/** Runs `fn` with the code at `sha`: in place for HEAD (the working tree, as `init` always did), else in a worktree. */
export async function withCode<T>(repoRoot: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
  return sha === headSha(repoRoot) ? fn(repoRoot) : withWorktree(repoRoot, sha, fn);
}

/** Analyzes the code in `dir` as commit `sha` and saves facts, snapshot and signals under the repo. */
export async function analyzeAt(repoRoot: string, dir: string, sha: string): Promise<Workspace> {
  const { facts, snapshot } = await analyze(dir, sha);
  saveAnalysis(repoRoot, facts, snapshot);
  const trees = buildCallTrees(facts, snapshot);
  const signals = computeSignals({ facts, trees, churn: fileChurn(dir, sha), readme: readReadme(dir) });
  saveSignals(repoRoot, signals);
  return { repoRoot, dir, sha, facts, snapshot, trees, signals };
}

/** The stored analysis of `sha`, read with its code in `dir`; undefined when `init` hasn't run for it. */
export function loadWorkspace(repoRoot: string, dir: string, sha: string): Workspace | undefined {
  if (!existsSync(storePaths(repoRoot, sha).facts)) return undefined;
  const facts = loadFacts(repoRoot, sha);
  const snapshot = loadSnapshot(repoRoot, sha);
  const trees = buildCallTrees(facts, snapshot);
  const signals = loadSignals(repoRoot, sha) ?? computeSignals({ facts, trees, churn: fileChurn(dir, sha), readme: readReadme(dir) });
  return { repoRoot, dir, sha, facts, snapshot, trees, signals };
}

export const workspaceAt = async (repoRoot: string, dir: string, sha: string): Promise<Workspace> => loadWorkspace(repoRoot, dir, sha) ?? analyzeAt(repoRoot, dir, sha);

/** Commits with a stored understanding tree. */
export function treeCommits(repoRoot: string): string[] {
  const dir = join(repoRoot, CATCHUP_DIR, "understanding");
  return existsSync(dir) ? readdirSync(dir).flatMap((f) => (f.endsWith(".json") ? [f.slice(0, -".json".length)] : [])) : [];
}

const isAncestor = (repoRoot: string, a: string, b: string): boolean => {
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The newest earlier commit that has a tree (the one to evolve from, D4), if any. */
export function ancestorWithTree(repoRoot: string, sha: string): string | undefined {
  return treeCommits(repoRoot)
    .filter((c) => c !== sha && isAncestor(repoRoot, c, sha))
    .map((c) => ({ c, date: Date.parse(commitInfo(repoRoot, c).date) }))
    .sort((x, y) => y.date - x.date)[0]?.c;
}

/** The change set between two commits with stored trees; saved as `changes/<from>..<to>.json`. */
export function changeSet(repoRoot: string, from: string, to: string): ChangeSet {
  const a = loadUnderstanding<Understanding>(repoRoot, from);
  const b = loadUnderstanding<Understanding>(repoRoot, to);
  if (!a || !b) throw new Error(`no understanding for ${(a ? to : from).slice(0, 9)}; run: catchup understand <path> --at ${(a ? to : from).slice(0, 9)}`);
  const changes = diffTrees({ understanding: a, facts: loadFacts(repoRoot, from) }, { understanding: b, facts: loadFacts(repoRoot, to) }, renamesBetween(repoRoot, from, to));
  saveChanges(repoRoot, changes);
  return changes;
}

export { resolveCommit };
