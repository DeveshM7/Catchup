import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Facts, Signals, Snapshot } from "@catchup/analyzer";

export const CATCHUP_DIR = ".catchup";

export type StoredPaths = { facts: string; snapshot: string; signals: string; explained: string; digest: string; understanding: string };

/** The change set between two commits (Build 6). */
export function changesPath(repoRoot: string, from: string, to: string): string {
  return join(repoRoot, CATCHUP_DIR, "changes", `${from}..${to}.json`);
}

export function saveChanges<T extends { from: string; to: string }>(repoRoot: string, changes: T): string {
  const path = changesPath(repoRoot, changes.from, changes.to);
  ensureIgnored(repoRoot);
  writeJson(path, changes);
  return path;
}

export function loadChanges<T>(repoRoot: string, from: string, to: string): T | undefined {
  const path = changesPath(repoRoot, from, to);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function storePaths(repoRoot: string, sha: string): StoredPaths {
  const base = join(repoRoot, CATCHUP_DIR);
  return {
    facts: join(base, "facts", `${sha}.json`),
    snapshot: join(base, "snapshots", `${sha}.json`),
    signals: join(base, "signals", `${sha}.json`),
    explained: join(base, "explained", `${sha}.json`),
    digest: join(base, "digest", sha),
    understanding: join(base, "understanding", `${sha}.json`),
  };
}

/** `.catchup/` ignores itself, so the analyzed repo's own files are never touched (D25). */
function ensureIgnored(repoRoot: string): void {
  const ignore = join(repoRoot, CATCHUP_DIR, ".gitignore");
  if (existsSync(ignore)) return;
  mkdirSync(join(repoRoot, CATCHUP_DIR), { recursive: true });
  writeFileSync(ignore, "*\n");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Saves facts and snapshot for one commit under `<repo>/.catchup/` (D15). */
export function saveAnalysis(repoRoot: string, facts: Facts, snapshot: Snapshot): StoredPaths {
  const paths = storePaths(repoRoot, facts.sha);
  ensureIgnored(repoRoot);
  writeJson(paths.facts, facts);
  writeJson(paths.snapshot, snapshot);
  return paths;
}

export function saveSignals(repoRoot: string, signals: Signals): string {
  const path = storePaths(repoRoot, signals.sha).signals;
  ensureIgnored(repoRoot);
  writeJson(path, signals);
  return path;
}

export function loadSignals(repoRoot: string, sha: string): Signals | undefined {
  const path = storePaths(repoRoot, sha).signals;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Signals) : undefined;
}

export function loadSnapshot(repoRoot: string, sha: string): Snapshot {
  return JSON.parse(readFileSync(storePaths(repoRoot, sha).snapshot, "utf8")) as Snapshot;
}

/** Claude's validated explanation of a commit (D23); typed by the caller to keep this package SDK-free. */
export function saveExplained<T extends { sha: string }>(repoRoot: string, explained: T): string {
  const path = storePaths(repoRoot, explained.sha).explained;
  ensureIgnored(repoRoot);
  writeJson(path, explained);
  return path;
}

export function loadExplained<T>(repoRoot: string, sha: string): T | undefined {
  const path = storePaths(repoRoot, sha).explained;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function loadFacts(repoRoot: string, sha: string): Facts {
  return JSON.parse(readFileSync(storePaths(repoRoot, sha).facts, "utf8")) as Facts;
}

/** Writes the digest files for one commit; returns their folder (D38). */
export function saveDigest(repoRoot: string, sha: string, files: Record<string, string>): string {
  const dir = storePaths(repoRoot, sha).digest;
  ensureIgnored(repoRoot);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), `${text}\n`);
  return dir;
}

/** The validated understanding tree (D37); typed by the caller to keep this package SDK-free. */
export function saveUnderstanding<T extends { sha: string }>(repoRoot: string, understanding: T): string {
  const path = storePaths(repoRoot, understanding.sha).understanding;
  ensureIgnored(repoRoot);
  writeJson(path, understanding);
  return path;
}

export function loadUnderstanding<T>(repoRoot: string, sha: string): T | undefined {
  const path = storePaths(repoRoot, sha).understanding;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

/** One run log per command: Claude calls, tool calls, tokens, time (D38). */
export function saveRun(repoRoot: string, startedAt: Date, run: unknown): string {
  const path = join(repoRoot, CATCHUP_DIR, "runs", `${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  ensureIgnored(repoRoot);
  writeJson(path, run);
  return path;
}
