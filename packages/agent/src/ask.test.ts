import type { Facts } from "@catchup/analyzer";
import { describe, expect, it } from "vitest";
import { askPrompt, askQuestion, checkAnswer, splitCites, type AskInputs } from "./ask.js";
import type { Runner } from "./droid.js";
import type { Understanding, UnderstandingNode } from "./tree.js";

const fn = (id: string) => ({ id, file: id.split("#")[0]!, name: id.split("#")[1]!, startLine: 1, endLine: 5, hash: "h" });
const facts: Facts = {
  sha: "s",
  files: ["app/api/chat/route.ts", "lib/db.ts", "components/composer.tsx"].map((path) => ({ path, lang: "typescript" as const, loc: 10 })),
  functions: [fn("app/api/chat/route.ts#POST"), fn("lib/db.ts#saveChat"), fn("components/composer.tsx#Composer.submit")],
  imports: [],
  calls: [],
  entryPoints: [],
};
const node = (id: string, kind: UnderstandingNode["kind"], title: string, files: string[], extra: Partial<UnderstandingNode> = {}): UnderstandingNode => ({
  id, kind, title, short: `${title} in short.`, long: `${title} at length.`, anchor: { files, functions: [] }, children: "leaf", depth: 1, basis: "b", ...extra,
});
const u: Understanding = {
  sha: "s",
  model: "m",
  summary: "A chat app.",
  parts: ["part:app", "part:lib/db.ts"],
  journeys: ["journey:ui:send"],
  systems: ["system:Postgres"],
  otherFlows: [],
  nodes: {
    "part:app": node("part:app", "part", "Server", ["app/api/chat/route.ts"]),
    "part:lib/db.ts": node("part:lib/db.ts", "part", "Database", ["lib/db.ts"]),
    "journey:ui:send": node("journey:ui:send", "journey", "Sending a message", ["components/composer.tsx"], { children: ["journey:ui:send#1"] }),
    "journey:ui:send#1": node("journey:ui:send#1", "step", "Save the chat", ["lib/db.ts"], { anchor: { files: ["lib/db.ts"], functions: ["lib/db.ts#saveChat"] }, stepKind: "main", depth: 2 }),
    "system:Postgres": node("system:Postgres", "system", "Postgres", ["lib/db.ts"], { depth: 0 }),
  },
  basis: "b",
};

/** A runner that plays answers in order and records prompts. */
function fake(answers: unknown[]): { runner: Runner; prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, runner: async (prompt) => (prompts.push(prompt), { ok: true, value: answers[Math.min(prompts.length - 1, answers.length - 1)] }) };
}

const base = (runner: Runner): AskInputs => ({ facts, understanding: u, question: "Where is a chat saved?", digestDir: "/d", digestNames: ["repo.md"], maxToolCalls: 20, runner });

describe("checkAnswer", () => {
  it("accepts box ids, function ids and file paths, with the decoration Claude copies from the map", () => {
    expect(checkAnswer({ answer: "In `saveChat`.", cites: ["journey:ui:send#1", "lib/db.ts#saveChat", "lib/db.ts"] }, facts, u)).toEqual([]);
    expect(checkAnswer({ answer: "x", cites: ["[part:lib/db.ts]", "`lib/db.ts#saveChat()`"] }, facts, u)).toEqual([]);
    expect(splitCites(["[part:lib/db.ts]", "`lib/db.ts#saveChat()`", "lib/db.ts#saveChat"], facts, u)).toEqual({ nodes: ["part:lib/db.ts"], functions: ["lib/db.ts#saveChat"], files: [], commits: [] });
  });

  it("rejects unknown cites, no cites, too many words", () => {
    expect(checkAnswer({ answer: "x", cites: ["lib/nope.ts", "part:nope"] }, facts, u)).toEqual([
      `cite "lib/nope.ts" is not a box id, function id or source file path`,
      `cite "part:nope" is not a box id, function id or source file path`,
    ]);
    expect(checkAnswer({ answer: "x", cites: [] }, facts, u)).toEqual(["expected 1–8 cites, got 0"]);
    expect(checkAnswer({ answer: Array(221).fill("w").join(" "), cites: ["lib/db.ts"] }, facts, u)).toEqual(["answer has 221 words (at most 150)"]);
  });

  it("does not treat inherited object properties as grounded box citations", () => {
    for (const cite of ["constructor", "toString", "__proto__"]) {
      expect(checkAnswer({ answer: "x", cites: [cite] }, facts, u)).toHaveLength(1);
      expect(splitCites([cite], facts, u).nodes).toEqual([]);
    }
  });
});

describe("askQuestion", () => {
  it("briefs the agent with the map, the selected box and the chat so far", () => {
    const prompt = askPrompt({ ...base(fake([]).runner), node: "journey:ui:send#1", history: [{ question: "What is this?", answer: "A chat app." }] });
    expect(prompt).toContain("- [part:lib/db.ts] Database: Database in short. — lib, 1 files");
    expect(prompt).toContain("  1. [journey:ui:send#1] Save the chat — lib/db.ts#saveChat");
    expect(prompt).toContain("The question is about this box: [journey:ui:send#1] Save the chat");
    expect(prompt).toContain("Inside: Sending a message");
    expect(prompt).toContain("Q: What is this?\nA: A chat app.");
    expect(prompt).toMatch(/=== Question ===\nWhere is a chat saved\?/);
  });

  it("retries once on bad cites, then splits the cites by kind", async () => {
    const { runner, prompts } = fake([
      { answer: "In `saveChat`.", cites: ["lib/db.ts#save"] },
      { answer: "In `saveChat`, called from `POST`.", cites: ["lib/db.ts#saveChat", "journey:ui:send#1", "app/api/chat/route.ts", "lib/db.ts#saveChat"] },
    ]);
    expect(await askQuestion(base(runner))).toEqual({
      answer: "In `saveChat`, called from `POST`.",
      nodes: ["journey:ui:send#1"],
      functions: ["lib/db.ts#saveChat"],
      files: ["app/api/chat/route.ts"],
      commits: [],
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`cite "lib/db.ts#save" is not a box id`);
  });

  it("fails loudly when the retry is still ungrounded", async () => {
    await expect(askQuestion(base(fake([{ answer: "Somewhere.", cites: ["x.ts"] }]).runner))).rejects.toThrow(/failed validation twice/);
  });
});

describe("asking about a change (Build 8)", () => {
  const sha = "45be7e580b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";
  const changes = {
    label: "45be7e5 → 89707e7",
    commits: [{ sha, date: "2026-01-01T00:00:00Z", subject: "Drop the auth check" }],
    changes: {
      from: "a", to: "b",
      files: { added: [], removed: [], renamed: [], changed: ["app/api/chat/route.ts"] },
      entryPoints: { added: [], removed: [] },
      systems: { added: [], removed: [] },
      nodes: { added: [], removed: [], changed: [] },
      journeys: [{ id: "journey:ui:send", title: "Sending a message", systemsAdded: [], systemsRemoved: [], stepsAdded: [], stepsRemoved: [], checksRemoved: ["Check the user"], functionsAdded: [], functionsRemoved: ["lib/auth.ts#requireUser"] }],
    },
  };

  it("briefs the agent with the change set and its commits", () => {
    const prompt = askPrompt({ ...base(fake([]).runner), changes });
    expect(prompt).toContain("=== The question is about a change: 45be7e5 → 89707e7 ===");
    expect(prompt).toContain("  checks removed: Check the user");
    expect(prompt).toContain("- 45be7e5 2026-01-01 Drop the auth check");
    expect(prompt).toContain("or commits by their short sha");
  });

  it("accepts a listed commit as a cite and returns its full sha; rejects unlisted ones", async () => {
    expect(checkAnswer({ answer: "x", cites: ["45be7e5", "deadbeef"] }, facts, u, changes.commits)).toEqual([
      `cite "deadbeef" is not a box id, function id or source file path, or a listed commit`,
    ]);
    const { runner } = fake([{ answer: "The check was dropped in 45be7e5.", cites: ["45be7e5", "app/api/chat/route.ts"] }]);
    expect(await askQuestion({ ...base(runner), changes })).toMatchObject({ commits: [sha], files: ["app/api/chat/route.ts"] });
  });

  it("briefs a preview selection from the newer tree while retaining removed-code citations", async () => {
    const cache = node("part:lib/cache.ts", "part", "Cache", ["lib/cache.ts"]);
    const after = {
      facts: { ...facts, files: [{ path: "lib/cache.ts", lang: "typescript" as const, loc: 10 }], functions: [fn("lib/cache.ts#cache")] },
      understanding: { ...u, parts: [cache.id], journeys: [], systems: [], nodes: { [cache.id]: cache } },
    };
    const { runner } = fake([{ answer: "Cache replaces the database.", cites: [cache.id, "lib/cache.ts#cache", "lib/cache.ts", "lib/db.ts"] }]);
    const inputs = { ...base(runner), node: cache.id, changes: { ...changes, after } };
    const prompt = askPrompt(inputs);
    expect(prompt).toContain("- [part:lib/cache.ts] Cache:");
    expect(prompt).toContain("The question is about this box: [part:lib/cache.ts] Cache");
    expect(prompt).toContain("Its files (1): lib/cache.ts");
    expect(askPrompt({ ...inputs, node: "part:lib/db.ts" })).toContain("The question is about this box: [part:lib/db.ts] Database");
    expect(await askQuestion(inputs)).toMatchObject({
      nodes: [cache.id], functions: ["lib/cache.ts#cache"], files: ["lib/cache.ts", "lib/db.ts"],
    });
  });
});

