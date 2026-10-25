import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const packageName = "history";

export type FileChurn = { commits: number; lastChanged: string };

const COMMIT_MARK = "\u0001";

/**
 * Parses `git log --format=<mark>%cI --name-only`: per file, how many commits touched it and the date of
 * the newest one (log order is newest first).
 */
export function parseChurn(log: string): Map<string, FileChurn> {
  const churn = new Map<string, FileChurn>();
  let date = "";
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      date = line.slice(COMMIT_MARK.length).trim();
      continue;
    }
    const path = line.trim();
    if (path === "" || date === "") continue;
    const seen = churn.get(path);
    if (seen) seen.commits += 1;
    else churn.set(path, { commits: 1, lastChanged: date });
  }
  return churn;
}

/** Commits per file up to `sha` (no merges, no rename following), paths relative to `repoRoot`: one `git log` pass. */
export function fileChurn(repoRoot: string, sha = "HEAD"): Map<string, FileChurn> {
  const log = execFileSync("git", ["-C", repoRoot, "log", "--no-merges", "--relative", `--format=${COMMIT_MARK}%cI`, "--name-only", sha], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseChurn(log);
}

const git = (repoRoot: string, args: string[]): string =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** A ref (`HEAD`, a tag, a short sha) as a full commit sha. */
export function resolveCommit(repoRoot: string, ref: string): string {
  return git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

export type Commit = { sha: string; date: string; subject: string; tags: string[] };

const FIELD = "\u001f";

/** Commits after `from` up to and including `to`, oldest first (no merges). */
export function commitsBetween(repoRoot: string, from: string, to: string): Commit[] {
  const out = git(repoRoot, ["log", "--reverse", "--no-merges", `--format=%H${FIELD}%cI${FIELD}%s${FIELD}%D`, `${from}..${to}`]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", date = "", subject = "", refs = ""] = line.split(FIELD);
      const tags = refs.split(", ").flatMap((r) => (r.startsWith("tag: ") ? [r.slice("tag: ".length)] : []));
      return { sha, date, subject, tags };
    });
}

/** One commit's date, subject and tags. */
export function commitInfo(repoRoot: string, ref: string): Commit {
  const [sha = "", date = "", subject = "", refs = ""] = git(repoRoot, ["show", "-s", `--format=%H${FIELD}%cI${FIELD}%s${FIELD}%D`, ref]).trim().split(FIELD);
  return { sha, date, subject, tags: refs.split(", ").flatMap((r) => (r.startsWith("tag: ") ? [r.slice("tag: ".length)] : [])) };
}

/** Parses `git diff -M --name-status -z`: renamed files, old path → new path. */
export function parseRenames(out: string): Map<string, string> {
  const renames = new Map<string, string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; ) {
    const status = parts[i] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      if (status.startsWith("R")) renames.set(parts[i + 1] ?? "", parts[i + 2] ?? "");
      i += 3;
    } else i += status ? 2 : 1;
  }
  return renames;
}

/** Files renamed between two commits (`git diff -M`), relative to `repoRoot`. */
export function renamesBetween(repoRoot: string, from: string, to: string): Map<string, string> {
  return parseRenames(git(repoRoot, ["diff", "-M", "--relative", "--name-status", "-z", from, to]));
}

/**
 * Runs `fn` on a checkout of `sha` in a temporary git worktree under `<repo>/.catchup/worktrees/` (inside the repo, so
 * packages resolve from its node_modules as they do for HEAD). The worktree is removed afterwards.
 */
export async function withWorktree<T>(repoRoot: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(repoRoot, ".catchup", "worktrees", sha.slice(0, 12));
  mkdirSync(dirname(dir), { recursive: true });
  // `.catchup/` ignores itself (D25), so the worktree never shows up in the repo's own file list.
  const ignore = join(repoRoot, ".catchup", ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  if (existsSync(dir)) git(repoRoot, ["worktree", "remove", "--force", dir]);
  git(repoRoot, ["worktree", "add", "--detach", "--force", dir, sha]);
  try {
    return await fn(dir);
  } finally {
    git(repoRoot, ["worktree", "remove", "--force", dir]);
    git(repoRoot, ["worktree", "prune"]);
  }
}

/**
 * About `count` commits between `from` and `to` (both included), oldest first: tagged commits first (evenly spread), the
 * rest evenly spaced in time (D7).
 */
export function pickCheckpoints(commits: Commit[], count: number): Commit[] {
  if (commits.length <= count) return commits;
  const first = commits[0]!;
  const last = commits.at(-1)!;
  const chosen = new Set<Commit>([first, last]);
  const spread = <T>(items: T[], n: number): T[] => (n <= 0 || items.length === 0 ? [] : Array.from({ length: Math.min(n, items.length) }, (_, i) => items[Math.round((i * (items.length - 1)) / Math.max(1, Math.min(n, items.length) - 1))]!));
  const tagged = commits.filter((c) => c.tags.length > 0 && !chosen.has(c));
  for (const c of spread(tagged, Math.floor((count - 2) / 2))) chosen.add(c);
  const start = Date.parse(first.date);
  const span = Date.parse(last.date) - start;
  for (let k = 1; chosen.size < count && k < count; k += 1) {
    const at = start + (span * k) / (count - 1);
    const nearest = commits.reduce((best, c) => (Math.abs(Date.parse(c.date) - at) < Math.abs(Date.parse(best.date) - at) ? c : best));
    chosen.add(nearest);
  }
  return commits.filter((c) => chosen.has(c));
}
