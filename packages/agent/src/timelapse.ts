import * as z from "zod/v4";
import { formatChanges, type ChangeSet } from "./changes.js";
import { askStructured, type Runner } from "./droid.js";
import { checkCount, words } from "./treecheck.js";

/** Timelapse captions (Build 9, D60): one short, cited caption per step between two checkpoints. */

const CAPTION_WORDS = { caption: { ask: 25, limit: 35 }, impact: { ask: 25, limit: 35 } } as const;
const MAX_LISTED_COMMITS = 60;
const SHORT = 7;

const TimelapseCaption = z.object({
  caption: z.string().min(1),
  impact: z.string().min(1),
  commits: z.array(z.string()),
});
export type TimelapseCaption = z.infer<typeof TimelapseCaption>;

export type StepCommit = { sha: string; date: string; subject: string };
export type Caption = { caption: string; impact: string; commits: string[] };

export type CaptionInputs = {
  summary: string;
  changes: ChangeSet;
  /** Commits in this step (after the previous checkpoint, up to this one), oldest first. */
  commits: StepCommit[];
  runner: Runner;
  onCall?: (job: string, attempt: number) => void;
  onRejected?: (job: string, problems: string[]) => void;
};

/** The commits shown to Claude: all of them when few, else the latest and the ones whose subjects say the most. */
function shownCommits(commits: StepCommit[]): StepCommit[] {
  if (commits.length <= MAX_LISTED_COMMITS) return commits;
  const latest = commits.slice(-MAX_LISTED_COMMITS / 2);
  const rest = commits.slice(0, -MAX_LISTED_COMMITS / 2).filter((c) => !/^(merge|bump|chore|fix typo|update readme)/i.test(c.subject));
  const spread = rest.filter((_, i) => i % Math.ceil(rest.length / (MAX_LISTED_COMMITS / 2)) === 0);
  return [...spread, ...latest];
}

export function captionPrompt(inputs: Omit<CaptionInputs, "runner">): string {
  const shown = shownCommits(inputs.commits);
  return [
    "You write one caption for a step of a codebase timelapse: what changed between two snapshots, for a developer catching up.",
    "",
    `The app (as it is now): ${inputs.summary}`,
    "",
    "What changed (computed from the code):",
    formatChanges(inputs.changes),
    "",
    `Commits in this step (${inputs.commits.length}${shown.length < inputs.commits.length ? `, ${shown.length} shown` : ""}), oldest first:`,
    ...shown.map((c) => `- ${c.sha.slice(0, SHORT)} ${c.date.slice(0, 10)} ${c.subject}`),
    "",
    "Return:",
    `- caption: at most ${CAPTION_WORDS.caption.ask} words, the headline of this step ("Artifacts arrive: the model can write documents into a side panel"). Plain words, no file paths.`,
    `- impact: at most ${CAPTION_WORDS.impact.ask} words, what it means for someone using or changing the code.`,
    "- commits: 1–4 short shas from the list above for the commits that did the most of it, most important first.",
    "Only claim what the change set or the commit subjects show.",
  ].join("\n");
}

/** The full sha a written short sha names, if it is in the step. */
function resolveSha(cite: string, commits: StepCommit[]): string | undefined {
  const key = cite.trim().replace(/^`|`$/g, "").toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(key)) return undefined;
  return commits.find((c) => c.sha.toLowerCase().startsWith(key))?.sha;
}

export function checkCaption(out: TimelapseCaption, commits: StepCommit[]): string[] {
  const problems = checkCount("commits", out.commits.length, commits.length ? 1 : 0, 4);
  for (const [field, text] of [["caption", out.caption], ["impact", out.impact]] as const) {
    const n = words(text);
    if (n > CAPTION_WORDS[field].limit) problems.push(`${field} has ${n} words (at most ${CAPTION_WORDS[field].ask})`);
  }
  for (const cite of out.commits) if (!resolveSha(cite, commits)) problems.push(`commit "${cite}" is not one of this step's commits`);
  return problems;
}

/** A checked caption for one step; commits are returned as full shas. */
export async function captionStep(inputs: CaptionInputs): Promise<Caption> {
  const out = await askStructured({
    job: `caption ${inputs.changes.from.slice(0, 7)}..${inputs.changes.to.slice(0, 7)}`,
    prompt: captionPrompt(inputs),
    schema: TimelapseCaption,
    check: (v) => checkCaption(v, inputs.commits),
    runner: inputs.runner,
    onCall: inputs.onCall,
    onRejected: inputs.onRejected,
  });
  return { caption: out.caption, impact: out.impact, commits: [...new Set(out.commits.flatMap((c) => resolveSha(c, inputs.commits) ?? []))] };
}
