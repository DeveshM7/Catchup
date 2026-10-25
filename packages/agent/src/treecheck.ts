import { WORDS, type StepsOutput } from "./tree.js";

export const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

type Field = keyof typeof WORDS;

/** Word caps per field, with slack. */
export function checkWords(where: string, fields: Partial<Record<Field, string>>): string[] {
  const problems: string[] = [];
  for (const [field, value] of Object.entries(fields) as [Field, string | undefined][]) {
    if (value === undefined) continue;
    const n = words(value);
    if (n > WORDS[field].limit) problems.push(`${where}: ${field} has ${n} words (at most ${WORDS[field].ask})`);
  }
  return problems;
}

const normalize = (path: string): string => path.trim().replace(/^\.\//, "").replace(/\/+$/, "");

export type Assignment = { files: string[][]; problems: string[] };

/**
 * Splits `files` among children by the paths Claude gave: each file goes to the child with the most specific
 * matching path (a file, or a folder holding it). Every file must land in exactly one child. A path that matches
 * none of `files` (a test folder, a stylesheet) is ignored: it claims nothing, and any file it was meant for
 * still has to land somewhere.
 */
export function assignFiles(children: { title: string; paths: string[] }[], files: string[]): Assignment {
  const problems: string[] = [];
  const owners = new Map<string, number>();
  children.forEach((child, i) => {
    for (const raw of child.paths) {
      const path = normalize(raw);
      const other = owners.get(path);
      if (other !== undefined && other !== i) problems.push(`path "${path}" is given to both "${children[other]!.title}" and "${child.title}"`);
      else owners.set(path, i);
    }
  });
  const assigned: string[][] = children.map(() => []);
  const missing: string[] = [];
  for (const file of files) {
    let best: { index: number; length: number } | undefined;
    for (const [path, index] of owners) {
      if ((file === path || file.startsWith(`${path}/`)) && (!best || path.length > best.length)) best = { index, length: path.length };
    }
    if (best) assigned[best.index]!.push(file);
    else missing.push(file);
  }
  if (missing.length) {
    const shown = missing.slice(0, 40);
    problems.push(`${missing.length} file(s) belong to no part: ${shown.join(", ")}${missing.length > shown.length ? ", …" : ""}`);
  }
  children.forEach((child, i) => {
    if (assigned[i]!.length === 0 && child.paths.length > 0) problems.push(`"${child.title}" gets no files (its paths match none of the files, or more specific paths took them all)`);
    if (child.paths.length === 0) problems.push(`"${child.title}" lists no paths`);
  });
  return { files: assigned, problems };
}

export function checkCount(what: string, got: number, min: number, max: number): string[] {
  return got < min || got > max ? [`expected ${min}–${max} ${what}, got ${got}`] : [];
}

export type StepRules = {
  /** Functions a step may cite. */
  allowed: Set<string>;
  /** Preorder position of each function's first appearance in the call tree. */
  order: Map<string, number>;
  /** For each function, the functions that enclose it (call it on some path); a step citing those spans the earlier one. */
  callers?: Map<string, Set<string>>;
  /** Must be in the first step (the entry handler), if any. */
  first?: string;
  /** Each group needs at least one cited function (a group = alternatives, e.g. `one of` requests). */
  mustCover: string[][];
  min: number;
  max: number;
};

/** Problems with a journey's (or a step's) steps (ARCHITECTURE §7). */
export function checkSteps(output: StepsOutput, rules: StepRules): string[] {
  const problems = checkCount("steps", output.steps.length, rules.min, rules.max);
  const cited = new Set<string>();
  let lastStart = -1;
  let lastTitle = "";
  let lastFresh: string[] = [];
  output.steps.forEach((step, i) => {
    const where = `step ${i + 1} ("${step.title}")`;
    problems.push(...checkWords(where, { title: step.title, short: step.short, long: step.long }));
    if (step.functions.length === 0) problems.push(`${where} cites no functions`);
    const fresh: number[] = [];
    const freshFns: string[] = [];
    for (const fn of step.functions) {
      if (!rules.allowed.has(fn)) {
        problems.push(`${where} cites "${fn}", which is not a function in this journey's call tree`);
        continue;
      }
      if (!cited.has(fn)) {
        fresh.push(rules.order.get(fn) ?? 0);
        freshFns.push(fn);
      }
    }
    for (const fn of step.functions) cited.add(fn);
    // Out of order only when all of a main step's new code runs before the previous step starts: a step may cite setup
    // that is called early but does its work late (a plugin built before the build that runs it) (D54).
    // A step citing code that encloses the previous step's (the handler both run in) spans it rather than running before.
    if (step.kind === "main" && fresh.length) {
      const encloses = freshFns.some((fn) => lastFresh.some((inner) => rules.callers?.get(inner)?.has(fn)));
      if (Math.max(...fresh) < lastStart && !encloses) problems.push(`${where} runs entirely before "${lastTitle}"; order the main steps as the code runs`);
      lastStart = Math.min(...fresh);
      lastTitle = step.title;
      lastFresh = freshFns;
    }
  });
  if (rules.first !== undefined && !output.steps[0]?.functions.includes(rules.first)) problems.push(`the first step must include the entry handler ${rules.first}`);
  const uncovered = rules.mustCover.filter((group) => !group.some((fn) => cited.has(fn)));
  if (uncovered.length) problems.push(`these key functions are in no step: ${uncovered.map((g) => g.join(" or ")).join(", ")}`);
  return problems;
}
