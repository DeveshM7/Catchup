import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees } from "@catchup/analyzer";
import { renderTree, importantFunctions } from "./brief.js";
import type { Runner } from "./droid.js";
import { explainSnapshot } from "./explain.js";

const TINY = fileURLToPath(new URL("../../../fixtures/tiny", import.meta.url));
const grouping = { splitAbove: 80, mergeBelow: 2, maxComponents: 25 };
const readFile = (path: string): string | undefined => readFileSync(join(TINY, path), "utf8");

/** Stands in for Claude: answers from the prompt so the pipeline is testable offline. */
const fakeClaude: Runner = async (prompt) => {
  if (prompt.startsWith("Name each component")) {
    const ids = [...prompt.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]);
    return { ok: true, value: { labels: ids.map((id) => ({ id, name: `Name ${id}`, description: "Does things." })) } };
  }
  if (prompt.startsWith("Group these runtime flows")) {
    const ids = [...prompt.matchAll(/^- (\S+ \S+): /gm)].map((m) => m[1]);
    const areas = ids.map((id, i) => ({ id: `area-${i + 1}`, name: `Area ${i + 1}`, description: "Some flows.", flows: [id] }));
    return { ok: true, value: { areas } };
  }
  const fns = [...new Set([...prompt.matchAll(/★ \[([^\]]+)\]/g)].map((m) => m[1]))];
  const handler = /handler \[([^\]]+)\]/.exec(prompt)?.[1] ?? "";
  const all = [handler, ...fns.filter((f) => f !== handler)];
  const steps = all.map((fn) => ({ id: null, label: `Run ${fn}`, summary: "Runs.", functions: [fn], kind: "main" }));
  while (steps.length < 4) steps.push({ id: null, label: "Finish", summary: "Ends.", functions: [handler], kind: "main" });
  return { ok: true, value: { steps: steps.slice(0, 8) } };
};

describe("explainSnapshot on fixtures/tiny (fake Claude)", async () => {
  const { facts, snapshot } = await analyze(TINY, "tiny-sha", { grouping });
  const trees = buildCallTrees(facts, snapshot);

  it("renders a brief with function IDs and flags", () => {
    const tree = trees.find((t) => t.entryPoint.label === "POST /api/login");
    if (!tree) throw new Error("missing tree");
    const text = renderTree(tree, { functions: new Map(facts.functions.map((f) => [f.id, f])), readFile });
    expect(text.split("\n").slice(0, 4)).toEqual([
      "[src/app/api/login/route.ts#POST] src/app/api/login/route.ts:9 {src}",
      "  - ★ [src/auth/login.ts#login] src/auth/login.ts:5 {src/auth}",
      "    - ★ [src/db/users.ts#findUser] src/db/users.ts:4 {src/db}",
      "      - ★ ⇢ Postgres: pool.query",
    ]);
    expect(text).toContain("(+");
    expect(importantFunctions(tree)[0]).toBe("src/app/api/login/route.ts#POST");
  });

  it("explains, validates, and a second run on the same commit changes nothing without calling Claude", async () => {
    const jobs: string[] = [];
    const base = { facts, snapshot, trees, runner: fakeClaude, model: "fake", readFile };
    const first = await explainSnapshot({ ...base, onCall: (job) => jobs.push(job) });
    expect(jobs).toEqual(["component labels", "flow GET /api/login", "flow POST /api/login", "flow POST /charge", "flow POST /login", "areas"]);
    const lengths = new Map(first.explained.flows.map((f) => [f.label, f.steps.length]));
    expect([lengths.get("GET /api/login"), lengths.get("POST /api/login")]).toEqual([4, 6]);
    const again = await explainSnapshot({ ...base, previous: first.explained, onCall: (job) => jobs.push(job) });
    expect(jobs).toHaveLength(6);
    expect(again.stats).toEqual({ claudeJobs: 0, carriedFlows: 4, updatedFlows: 0, newFlows: 0, carriedLabels: snapshot.components.length, carriedOverview: true });
    expect(JSON.stringify(again.explained)).toBe(JSON.stringify(first.explained));
  });

  it("re-explains only the flow whose function changed, keeping untouched steps verbatim", async () => {
    const first = await explainSnapshot({ facts, snapshot, trees, runner: fakeClaude, model: "fake", readFile });
    const changed = {
      ...facts,
      functions: facts.functions.map((f) => (f.id === "src/db/users.ts#findUser" ? { ...f, hash: "changed" } : f)),
    };
    const jobs: string[] = [];
    const update = await explainSnapshot({
      facts: changed,
      snapshot,
      trees,
      previous: first.explained,
      runner: async (prompt, schema) => {
        if (!prompt.includes("Previous steps:")) return fakeClaude(prompt, schema);
        const previous = first.explained.flows.find((f) => f.steps.every((s) => s.id !== null && prompt.includes(s.id)));
        const steps = (previous?.steps ?? []).map((s) => ({ id: s.id, label: `${s.label}!`, summary: s.summary, functions: s.functions, kind: s.kind }));
        return { ok: true, value: { steps } };
      },
      model: "fake",
      readFile,
      onCall: (job) => jobs.push(job),
    });
    // findUser runs in both login flows (Next.js route and Express route).
    expect(jobs).toEqual(["flow POST /api/login", "flow POST /login"]);
    const before = first.explained.flows.find((f) => f.label === "POST /api/login");
    const after = update.explained.flows.find((f) => f.label === "POST /api/login");
    const changedStep = before?.steps.findIndex((s) => s.functions.includes("src/db/users.ts#findUser")) ?? -1;
    after?.steps.forEach((step, i) => {
      if (i === changedStep) expect(step.label.endsWith("!")).toBe(true);
      else expect(step).toEqual(before?.steps[i]);
    });
  });
});
