import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, computeSignals } from "@catchup/analyzer";
import { buildDigest, unusedExports } from "./digest.js";
import type { Runner } from "./droid.js";
import type { ChildrenOutput, ExtrasOutput, StepsOutput, SurveyOutput, Understanding } from "./tree.js";
import { keyFunctionGroups } from "./journey.js";
import { openNode, understand, type UnderstandInputs } from "./understand.js";

const REPO = fileURLToPath(new URL("../../../fixtures/tiny-web", import.meta.url));
const readFile = (path: string): string | undefined => readFileSync(join(REPO, path), "utf8");

const survey: SurveyOutput = {
  summary: "A chat page that saves chats and streams a title back.",
  parts: [
    { title: "Chat screen", short: "What the user sees and clicks.", long: "The page and its components.", paths: ["components", "app/page.tsx", "lib/fetcher.ts"] },
    { title: "Server", short: "Routes and actions the browser calls.", long: "Handles requests.", paths: ["app/api", "app/actions.ts"] },
    { title: "Database", short: "Reads and writes chats.", long: "Postgres queries.", paths: ["lib/db.ts"] },
  ],
  journeys: [{ entry: "ui:components/composer.tsx#Composer.submit", title: "Sending a message", short: "You send a message.", long: "The browser posts it." }],
  otherFlows: [
    { family: "ui:components/chat.tsx#Chat.onClick:button", line: "Clear all chats." },
    { family: "ui:components/chat.tsx#Chat.onClick:button~2", line: "Rename a chat." },
    { family: "action:app/actions.ts#rename", line: "Rename on the server." },
    { family: "http:DELETE /api/history", line: "Delete history." },
    { family: "http:GET /api/history", line: "List history." },
    // As Claude sometimes copies it from the heading.
    { family: "Family 6: `http:DELETE /api/chat`", line: "Delete one chat." },
  ],
};
const screenChildren: ChildrenOutput = {
  leaf: false,
  children: [
    { title: "Composer", short: "Where you type.", long: "The input box.", paths: ["components/composer.tsx"] },
    { title: "Chat view", short: "Shows the chat.", long: "Page and chat.", paths: ["components", "app/page.tsx", "lib/fetcher.ts"] },
  ],
};
const steps: StepsOutput = {
  steps: [
    { title: "Send the message", short: "You press send.", long: "The composer posts.", kind: "main", functions: ["components/composer.tsx#Composer.submit"], open: false },
    { title: "Save the chat", short: "The server stores it.", long: "Postgres insert.", kind: "main", functions: ["app/api/chat/route.ts#POST", "lib/db.ts#saveChat"], open: true },
    { title: "Show the title", short: "The browser gets a title.", long: "A data-title part.", kind: "main", functions: ["components/parts.ts#handlePart"], open: false },
  ],
};
const extras: ExtrasOutput = {
  glossary: [
    { term: "Data part", meaning: "A typed message the server streams.", cites: ["components/parts.ts#handlePart"] },
    { term: "Chat", meaning: "A saved conversation.", cites: ["lib/db.ts"] },
    { term: "Action", meaning: "A server function the page calls.", cites: ["app/actions.ts#rename"] },
  ],
  startHere: [
    { file: "app/api/chat/route.ts", why: "The server side of sending." },
    { file: "components/chat.tsx", why: "The screen." },
  ],
  changes: [
    { task: "Change what is saved", cites: ["lib/db.ts#saveChat"] },
    { task: "Add a button", cites: ["components/chat.tsx"] },
    { task: "Handle a new message type", cites: ["components/parts.ts"] },
  ],
  surprises: [],
};

function fakes(overrides: Record<string, unknown[]> = {}): { runnerFor: (pass: string) => Runner; calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, unknown[]> = {
    survey: [survey],
    "part:Chat screen": [screenChildren],
    "part:Server": [{ leaf: true, children: [] }],
    "journey:Sending a message": [steps],
    extras: [extras],
    "open:Save the chat": [
      {
        steps: [
          { title: "Handle the post", short: "s", long: "l", kind: "main", functions: ["app/api/chat/route.ts#POST"], open: false },
          { title: "Insert the chat", short: "s", long: "l", kind: "main", functions: ["lib/db.ts#saveChat"], open: false },
        ],
      },
    ],
    ...overrides,
  };
  const runnerFor = (pass: string): Runner => {
    let attempt = 0;
    return async () => {
      calls.push(pass);
      const list = answers[pass];
      if (!list) throw new Error(`unexpected pass ${pass}`);
      return { ok: true, value: list[Math.min(attempt++, list.length - 1)] };
    };
  };
  return { runnerFor, calls };
}

describe("understand on fixtures/tiny-web (fake Claude)", async () => {
  const { facts, snapshot } = await analyze(REPO, "tiny-web-sha");
  const trees = buildCallTrees(facts, snapshot);
  const signals = computeSignals({ facts, trees });
  const digest = buildDigest({ facts, snapshot, signals, trees, readFile });
  const base = (runnerFor: (pass: string) => Runner, previous?: Understanding): UnderstandInputs => ({
    facts, snapshot, signals, trees, digest: digest.files, digestDir: "/digest", maxToolCalls: 20, readFile, model: "m", previous, runnerFor,
  });

  const first = await understand(base(fakes().runnerFor));
  const { understanding: tree } = first;

  it("asks journeys to cover the handler, messages, and one request per function that makes requests", () => {
    const page = trees.find((t) => t.entryPoint.label === "page /")!;
    expect(keyFunctionGroups(page)).toEqual([
      ["app/page.tsx#Page"],
      ["app/api/chat/route.ts#DELETE", "app/api/chat/route.ts#POST", "app/api/history/route.ts#DELETE", "app/api/history/route.ts#GET"],
      ["components/parts.ts#handlePart"],
    ]);
  });

  it("builds parts, journeys and steps with code-made ids and computed systems", () => {    expect(first.stats.calls).toBe(5);
    expect(tree.parts).toEqual(["part:components/chat.tsx", "part:app", "part:lib/db.ts"]);
    expect(tree.systems).toEqual(["system:AI model (AI SDK)", "system:Postgres"]);
    const screen = tree.nodes["part:components/chat.tsx"]!;
    expect(screen.children).toEqual(["part:components/composer.tsx", "part:components/chat.tsx~2"]);
    expect(tree.nodes["part:components/chat.tsx~2"]!.anchor.files).toEqual(["app/page.tsx", "components/chat.tsx", "components/parts.ts", "lib/fetcher.ts"]);
    expect(tree.nodes["part:app"]!.children).toBe("leaf");
    expect(tree.nodes["part:lib/db.ts"]!.children).toBe("leaf");

    const journey = tree.nodes["journey:ui:components/composer.tsx#Composer.submit"]!;
    expect(journey.systems).toEqual(["AI model (AI SDK)", "Postgres"]);
    expect(journey.parts).toEqual(["part:app", "part:components/chat.tsx", "part:lib/db.ts"]);
    const stepIds = journey.children as string[];
    expect(stepIds).toHaveLength(3);
    for (const id of stepIds) expect(id).toMatch(/^journey:ui:components\/composer\.tsx#Composer\.submit#[0-9a-f]{8}$/);
    const save = tree.nodes[stepIds[1]!]!;
    expect(save).toMatchObject({ kind: "step", stepKind: "main", parts: ["part:app", "part:lib/db.ts"], systems: ["AI model (AI SDK)", "Postgres"], children: "unopened", depth: 2 });
    expect(tree.nodes[stepIds[2]!]!.children).toBe("leaf");
    expect(tree.otherFlows.map((f) => f.line)).toEqual(["Clear all chats.", "Rename a chat.", "Rename on the server.", "Delete one chat.", "Delete history.", "List history."]);
    expect(tree.extras?.glossary[1]).toEqual({ term: "Chat", meaning: "A saved conversation.", files: ["lib/db.ts"], functions: [] });
  });

  it("makes no Claude calls and writes identical bytes when nothing changed", async () => {
    const again = fakes();
    const second = await understand(base(again.runnerFor, tree));
    expect(again.calls).toEqual([]);
    expect(second.stats.calls).toBe(0);
    expect(JSON.stringify(second.understanding)).toBe(JSON.stringify(tree));
  });

  it("retries a rejected survey with the problems, then fails loudly", async () => {
    const badSurvey = { ...survey, parts: survey.parts.slice(0, 2) };
    const retried = fakes({ survey: [badSurvey, survey] });
    const rejected: string[][] = [];
    await understand({ ...base(retried.runnerFor), onRejected: (_job, problems) => rejected.push(problems) });
    expect(retried.calls.filter((c) => c === "survey")).toHaveLength(2);
    expect(rejected[0]).toEqual(["1 file(s) belong to no part: lib/db.ts"]);
    await expect(understand(base(fakes({ survey: [badSurvey] }).runnerFor))).rejects.toThrow(/belong to no part/);
  });

  it("opens a step into sub-steps on demand and keeps them on the next run", async () => {
    const stepIds = tree.nodes["journey:ui:components/composer.tsx#Composer.submit"]!.children as string[];
    const opener = fakes();
    const opened = await openNode(base(opener.runnerFor), tree, stepIds[1]!);
    expect(opener.calls).toEqual(["open:Save the chat"]);
    const children = opened.understanding.nodes[stepIds[1]!]!.children as string[];
    expect(children).toHaveLength(2);
    expect(opened.understanding.nodes[children[1]!]).toMatchObject({ depth: 3, anchor: { functions: ["lib/db.ts#saveChat"] }, systems: ["Postgres"] });

    const rerun = fakes();
    const kept = await understand(base(rerun.runnerFor, opened.understanding));
    expect(rerun.calls).toEqual([]);
    expect(JSON.stringify(kept.understanding)).toBe(JSON.stringify(opened.understanding));
  });

  it("rejects two journeys from one flow family (D54)", async () => {
    const twice = { ...survey, journeys: [...survey.journeys, { entry: "http:POST /api/chat", title: "Posting a chat", short: "s", long: "l" }] };
    await expect(understand(base(fakes({ survey: [twice] }).runnerFor))).rejects.toThrow(/"Sending a message" and "Posting a chat" run mostly the same code/);
  });

  it("lists exported functions nothing calls as possibly unused, never entry points (D54)", () => {
    expect(unusedExports({ facts, signals })).toEqual([]);
    expect(digest.files["hot.md"]).toContain("## Possibly unused\n");
    const fn = (id: string, exported = true) => ({ id, file: id.split("#")[0]!, name: id.split("#")[1]!, startLine: 1, endLine: 2, hash: "h", exported });
    const kit = ["kit.tsx#A", "kit.tsx#B", "kit.tsx#C"];
    const handmade = {
      ...facts,
      functions: [fn("run.ts#runCode"), fn("cli.ts#main"), fn("used.ts#helper"), fn("local.ts#inner", false), fn("cls.ts#Pool.add"), ...kit.map((id) => fn(id))],
      entryPoints: [{ id: "cli:$ x", kind: "cli" as const, label: "$ x", handler: "cli.ts#main", file: "cli.ts" }],
    };
    const quiet = { flows: 0, systems: [], fanIn: 0, exported: true, loc: 2, readme: false };
    const sig = { ...signals, functions: Object.fromEntries(handmade.functions.map((f) => [f.id, f.id === "used.ts#helper" ? { ...quiet, fanIn: 2 } : quiet])) };
    // Lone unused exports first, then the kit; entry handlers, called, local and member functions never.
    expect(unusedExports({ facts: handmade, signals: sig })).toEqual(["run.ts#runCode", ...kit]);
  });

  it("rejects steps that cite functions outside the journey", async () => {
    const bad = { steps: [{ ...steps.steps[0]!, functions: ["components/composer.tsx#Composer.submit", "lib/db.ts#listChats"] }, ...steps.steps.slice(1)] };
    const run = fakes({ "journey:Sending a message": [bad] });
    await expect(understand(base(run.runnerFor))).rejects.toThrow(/lib\/db\.ts#listChats", which is not a function in this journey/);
  });
});
