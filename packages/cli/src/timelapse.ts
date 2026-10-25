import { execFileSync } from "node:child_process";
import { captionStep, remapper, type Caption, type Runner, type Understanding } from "@catchup/agent";
import { commitInfo, commitsBetween, pickCheckpoints, renamesBetween, type Commit } from "@catchup/history";
import { loadCaption, loadFacts, loadSignals, loadUnderstanding, saveCaption, saveTimelapse } from "@catchup/store";
import { buildTimelapse, type Checkpoint, type Step, type TimelapseView } from "@catchup/web";
import { changeSet, withCode, workspaceAt } from "./commits.js";

/** Timelapse A → B (Build 9, D60): checkpoints oldest first, each tree evolved from the one before, captioned per step. */

/** Below this share of files carried over from the previous checkpoint, a tree is written fresh instead of evolved. */
const MIN_OVERLAP = 0.5;

export type TreeAt = (repoRoot: string, sha: string, options: { maxCalls: number; from?: string; fresh?: boolean; quiet?: boolean }) => Promise<{ understanding: Understanding }>;

export type TimelapseOptions = {
  from?: string;
  to: string;
  count: number;
  maxCalls: number;
  treeAt: TreeAt;
  captionRunner: Runner;
  say: (line: string) => void;
};

function firstCommit(repoRoot: string, to: string): string {
  const roots = execFileSync("git", ["-C", repoRoot, "rev-list", "--max-parents=0", to], { encoding: "utf8" }).trim().split("\n");
  return roots.at(-1)!;
}

/** Share of the files at `to` that existed at `from` (through renames). */
function overlap(repoRoot: string, from: string, to: string): number {
  const a = loadFacts(repoRoot, from);
  const b = loadFacts(repoRoot, to);
  const map = remapper(a, b, renamesBetween(repoRoot, from, to));
  const carried = new Set(a.files.flatMap((f) => map.file(f.path) ?? []));
  return b.files.length === 0 ? 1 : b.files.filter((f) => carried.has(f.path)).length / b.files.length;
}

export async function runTimelapse(repoRoot: string, options: TimelapseOptions): Promise<TimelapseView> {
  const from = options.from ?? firstCommit(repoRoot, options.to);
  const commits: Commit[] = [commitInfo(repoRoot, from), ...commitsBetween(repoRoot, from, options.to)];
  const picked = pickCheckpoints(commits, options.count);
  options.say(`${picked.length} checkpoints from ${commits.length} commits (${picked[0]!.date.slice(0, 10)} → ${picked.at(-1)!.date.slice(0, 10)})`);

  let prev: string | undefined;
  const kept: Commit[] = [];
  for (const [i, cp] of picked.entries()) {
    const started = Date.now();
    let how = "stored";
    try {
      await withCode(repoRoot, cp.sha, (dir) => workspaceAt(repoRoot, dir, cp.sha));
      const stored = loadUnderstanding<Understanding>(repoRoot, cp.sha);
      if (stored && stored.from === undefined && stored.extras === undefined) {
        // A fresh tree an earlier run left half-written: finish it (finished passes are carried, D4).
        await options.treeAt(repoRoot, cp.sha, { maxCalls: options.maxCalls, quiet: true });
        how = "fresh (resumed)";
      } else if (!stored) {
        const share = prev === undefined ? 0 : overlap(repoRoot, prev, cp.sha);
        if (prev !== undefined && share >= MIN_OVERLAP) {
          const { understanding } = await options.treeAt(repoRoot, cp.sha, { maxCalls: options.maxCalls, from: prev, quiet: true });
          how = `evolved (${Math.round(share * 100)}% of files carried over)`;
          // Every journey gone: the app changed too much to carry its story; write this checkpoint afresh.
          if (understanding.journeys.length === 0 && (loadUnderstanding<Understanding>(repoRoot, prev)?.journeys.length ?? 0) > 0) {
            await options.treeAt(repoRoot, cp.sha, { maxCalls: options.maxCalls, fresh: true, quiet: true });
            how = "fresh (no journey survived)";
          }
        } else {
          await options.treeAt(repoRoot, cp.sha, { maxCalls: options.maxCalls, fresh: true, quiet: true });
          how = prev === undefined ? "fresh (first)" : `fresh (${Math.round(share * 100)}% of files carried over)`;
        }
      }
    } catch (e) {
      // One checkpoint that can't be understood doesn't stop the timelapse; the next step spans it.
      options.say(`  ${String(i + 1).padStart(2)}/${picked.length} ${cp.sha.slice(0, 7)} ${cp.date.slice(0, 10)} skipped: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
      continue;
    }
    options.say(`  ${String(i + 1).padStart(2)}/${picked.length} ${cp.sha.slice(0, 7)} ${cp.date.slice(0, 10)} ${how}, ${((Date.now() - started) / 1000).toFixed(0)} s — ${cp.subject.slice(0, 60)}`);
    kept.push(cp);
    prev = cp.sha;
  }
  if (kept.length < 2) throw new Error("fewer than two checkpoints could be understood");

  const checkpoints: Checkpoint[] = kept.map((cp) => {
    const facts = loadFacts(repoRoot, cp.sha);
    const signals = loadSignals(repoRoot, cp.sha);
    if (!signals) throw new Error(`no signals for ${cp.sha.slice(0, 9)}; run: catchup init <path> --at ${cp.sha.slice(0, 9)}`);
    return { commit: { sha: cp.sha, date: cp.date, subject: cp.subject, tags: cp.tags }, understanding: loadUnderstanding<Understanding>(repoRoot, cp.sha)!, facts, signals };
  });

  const steps: Step[] = [];
  for (let i = 1; i < kept.length; i += 1) {
    const a = kept[i - 1]!.sha;
    const b = kept[i]!.sha;
    const changes = changeSet(repoRoot, a, b);
    const span = commitsBetween(repoRoot, a, b).map(({ sha, date, subject }) => ({ sha, date, subject }));
    let caption = loadCaption<Caption>(repoRoot, a, b);
    if (!caption) {
      caption = await captionStep({ summary: checkpoints[i]!.understanding.summary, changes, commits: span, runner: options.captionRunner });
      saveCaption(repoRoot, a, b, caption);
    }
    options.say(`  step ${i}: ${caption.caption}`);
    steps.push({ changes, caption, commits: span });
  }

  const view = await buildTimelapse(checkpoints, steps);
  saveTimelapse(repoRoot, view);
  return view;
}
