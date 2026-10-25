import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, computeSignals, type Facts } from "@catchup/analyzer";
import { renamesBetween, resolveCommit, withWorktree } from "@catchup/history";
import { diffTrees } from "./changes.js";
import { buildDigest } from "./digest.js";
import type { Runner } from "./droid.js";
import { evolve } from "./evolve.js";
import type { Understanding } from "./tree.js";
import { understand, type UnderstandInputs } from "./understand.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/tiny-changes", import.meta.url));

/** A git repo with two commits: v1, then v2 (the planted changes, see fixtures/tiny-changes/README.md). */
function plantedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "catchup-changes-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q", "-b", "main");
  cpSync(join(FIXTURE, "v1"), repo, { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", "v1");
  for (const entry of readdirSync(repo)) if (entry !== ".git") rmSync(join(repo, entry), { recursive: true, force: true });
  cpSync(join(FIXTURE, "v2"), repo, { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", "v2: export, http rename, redis, no auth check");
  return repo;
}

/** Plays scripted answers per pass and records which passes ran. */
function fakes(answers: Record<string, unknown>): { runnerFor: (pass: string) => Runner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runnerFor: (pass) => async () => {
      calls.push(pass);
      if (!(pass in answers)) throw new Error(`unexpected pass ${pass}`);
      return { ok: true, value: answers[pass] };
    },
  };
}

const SEND = "ui:components/composer.tsx#Composer.submit";
/** Fake Claude answers for v1 (fresh Understand) and v2 (relabel + journey update), shared with the preview test. */
const { v1: v1Answers, v2: v2Answers } = JSON.parse(readFileSync(join(FIXTURE, "answers.json"), "utf8")) as { v1: Record<string, unknown>; v2: Record<string, unknown> };

type Commit = { sha: string; facts: Facts; inputs: (runnerFor: (pass: string) => Runner, previous?: Understanding) => UnderstandInputs };

async function analyzeCommit(repo: string, ref: string): Promise<Commit> {
  const sha = resolveCommit(repo, ref);
  return withWorktree(repo, sha, async (dir) => {
    const { facts, snapshot } = await analyze(dir, sha);
    const trees = buildCallTrees(facts, snapshot);
    const signals = computeSignals({ facts, trees });
    const readFile = (path: string): string | undefined => readFileSync(join(dir, path), "utf8");
    const digest = buildDigest({ facts, snapshot, signals, trees, readFile });
    const files = Object.fromEntries(facts.files.map((f) => [f.path, readFile(f.path)]));
    return {
      sha,
      facts,
      inputs: (runnerFor, previous) => ({ facts, snapshot, signals, trees, digest: digest.files, digestDir: "/digest", maxToolCalls: 20, readFile: (p) => files[p], model: "m", previous, runnerFor }),
    };
  });
}

describe("evolve and diff on planted changes (Build 6)", async () => {
  const repo = plantedRepo();
  const a = await analyzeCommit(repo, "HEAD~1");
  const b = await analyzeCommit(repo, "HEAD");
  const renames = renamesBetween(repo, a.sha, b.sha);
  const treeA = (await understand(a.inputs(fakes(v1Answers).runnerFor))).understanding;
  const run = fakes(v2Answers);
  const evolved = await evolve({ ...b.inputs(run.runnerFor), from: { understanding: treeA, facts: a.facts }, renames });
  const treeB = evolved.understanding;
  const changes = diffTrees({ understanding: treeA, facts: a.facts }, { understanding: treeB, facts: b.facts }, renames);

  it("analyzes each commit in a worktree and finds the rename", () => {
    expect([...renames]).toEqual([["lib/fetcher.ts", "lib/http.ts"]]);
    expect(b.facts.files.map((f) => f.path)).toContain("lib/http.ts");
  });

  it("asks Claude only to re-tell the changed journey and relabel what changed", () => {
    expect(run.calls.sort()).toEqual(["relabel", "update:Sending a message"]);
    expect(treeB.from).toBe(a.sha);
    expect(treeB.sha).toBe(b.sha);
  });

  it("detects every planted change and nothing else", () => {
    expect(changes.files).toEqual({
      added: ["app/api/export/route.ts", "lib/export.ts"],
      removed: [],
      renamed: [{ from: "lib/fetcher.ts", to: "lib/http.ts" }],
      changed: ["app/api/chat/route.ts", "lib/db.ts"],
    });
    expect(changes.entryPoints).toEqual({ added: ["GET /api/export"], removed: [] });
    expect(changes.systems).toEqual({ added: ["Redis"], removed: [] });
    expect(changes.journeys).toEqual([
      {
        id: `journey:${SEND}`,
        title: "Sending a message",
        systemsAdded: ["Redis"],
        systemsRemoved: [],
        stepsAdded: [],
        stepsRemoved: [],
        checksRemoved: ["Check the user"],
        functionsAdded: [],
        functionsRemoved: ["lib/auth.ts#requireUser"],
      },
    ]);
    // The check step was re-cut into "Accept the message" (half its functions): one changed step, same id (D57).
    expect(changes.nodes.added.map((n) => n.title)).toEqual(["Redis"]);
    expect(changes.nodes.removed.map((n) => n.title)).toEqual([]);
    expect(changes.nodes.changed.map((n) => [n.title, n.what])).toEqual([
      ["Sending a message", ["text", "code", "systems"]],
      ["Accept the message", ["text", "code"]],
      ["Save the chat", ["text", "systems"]],
      ["Server", ["text", "code"]],
      ["Data and auth", ["text", "code"]],
    ]);
  });

  it("keeps unchanged nodes' ids and text, reading their anchors through the rename", () => {
    const screenA = Object.values(treeA.nodes).find((n) => n.title === "Chat screen")!;
    const screenB = treeB.nodes[screenA.id]!;
    expect({ ...screenB, anchor: undefined }).toEqual({ ...screenA, anchor: undefined });
    expect(screenB.anchor.files).toContain("lib/http.ts");
    const send = (u: Understanding) => Object.values(u.nodes).find((n) => n.title === "Send the message")!;
    expect(send(treeB)).toEqual(send(treeA));
    const title = (u: Understanding) => Object.values(u.nodes).find((n) => n.title === "Show the title")!;
    expect(title(treeB)).toEqual(title(treeA));
    expect(treeB.otherFlows.find((f) => f.family === "http:GET /api/export")?.line).toBe("Download all chats as JSON.");
    expect(treeB.extras?.startHere.map((s) => s.file)).toEqual(["app/api/chat/route.ts", "lib/http.ts"]);
    expect(treeB.extras?.glossary[1]?.functions).toEqual(["lib/http.ts#fetcher"]);
  });

  it("places new files by folder and keeps the change idempotent", async () => {
    const data = Object.values(treeB.nodes).find((n) => n.title === "Data and auth")!;
    expect(data.anchor.files).toEqual(["lib/auth.ts", "lib/db.ts", "lib/export.ts"]);
    const again = await evolve({ ...b.inputs(fakes(v2Answers).runnerFor), from: { understanding: treeA, facts: a.facts }, renames });
    expect(JSON.stringify(again.understanding)).toBe(JSON.stringify(treeB));
    const stay = fakes({});
    expect((await understand(b.inputs(stay.runnerFor, treeB))).understanding).toBe(treeB);
    expect(stay.calls).toEqual([]);
  });

  it("changes nothing when nothing changed", async () => {
    const same = fakes({});
    const self = await evolve({ ...a.inputs(same.runnerFor), from: { understanding: treeA, facts: a.facts }, renames: new Map() });
    expect(same.calls).toEqual([]);
    const none = diffTrees({ understanding: treeA, facts: a.facts }, { understanding: self.understanding, facts: a.facts }, new Map());
    expect(none.nodes).toEqual({ added: [], removed: [], changed: [] });
    expect(none.journeys).toEqual([]);
  });
});

describe("offline evolve for the live preview (Build 7)", async () => {
  const repo = plantedRepo();
  const a = await analyzeCommit(repo, "HEAD~1");
  const b = await analyzeCommit(repo, "HEAD");
  const renames = renamesBetween(repo, a.sha, b.sha);
  const treeA = (await understand(a.inputs(fakes(v1Answers).runnerFor))).understanding;

  it("makes no Claude call, keeps texts, drops steps whose code is gone, and still reports every planted change", async () => {
    const none = fakes({});
    const { understanding: preview } = await evolve({ ...b.inputs(none.runnerFor), from: { understanding: treeA, facts: a.facts }, renames, offline: true });
    expect(none.calls).toEqual([]);
    const journey = preview.nodes[`journey:${SEND}`]!;
    const steps = (journey.children as string[]).map((id) => preview.nodes[id]!);
    expect(steps.map((s) => [s.title, s.anchor.functions])).toEqual([
      ["Send the message", ["components/composer.tsx#Composer.submit"]],
      ["Check the user", ["app/api/chat/route.ts#POST"]],
      ["Save the chat", ["lib/db.ts#saveChat"]],
      ["Show the title", ["components/parts.ts#handlePart"]],
    ]);
    const changes = diffTrees({ understanding: treeA, facts: a.facts }, { understanding: preview, facts: b.facts }, renames);
    expect(changes.journeys[0]).toMatchObject({ systemsAdded: ["Redis"], checksRemoved: ["Check the user"], functionsRemoved: ["lib/auth.ts#requireUser"] });
    expect(changes.entryPoints.added).toEqual(["GET /api/export"]);
  });
});
