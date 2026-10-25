import { execFileSync } from "node:child_process";

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
