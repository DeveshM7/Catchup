import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, computeSignals } from "@catchup/analyzer";
import type { Understanding, UnderstandingNode } from "@catchup/agent";
import { TreeState } from "./server/server.js";
import { canvasGraph, treeData } from "./server/understanding.js";

const TINY_WEB = fileURLToPath(new URL("../../../fixtures/tiny-web", import.meta.url));

type Given = Partial<UnderstandingNode> & Pick<UnderstandingNode, "id" | "kind" | "title">;
const node = (n: Given): UnderstandingNode => ({ short: `${n.title} short`, long: `${n.title} long`, anchor: { files: [], functions: [] }, children: "leaf", depth: 1, basis: "b", ...n });

const J = "journey:ui:components/composer.tsx#Composer.submit";
const SUBMIT = "components/composer.tsx#Composer.submit";
const POST = "app/api/chat/route.ts#POST";
const SAVE = "lib/db.ts#saveChat";
const HANDLE = "components/parts.ts#handlePart";
const screenFiles = ["app/page.tsx", "components/chat.tsx", "components/composer.tsx", "components/parts.ts", "lib/fetcher.ts"];

const understanding: Understanding = {
  sha: "tiny-web-sha",
  model: "m",
  summary: "A chat page that saves chats.",
  parts: ["part:components", "part:app", "part:lib/db.ts"],
  journeys: [J],
  systems: ["system:Postgres"],
  otherFlows: [],
  basis: "b",
  nodes: Object.fromEntries(
    [
      node({ id: "part:components", kind: "part", title: "Chat screen", anchor: { files: screenFiles, functions: [] }, children: ["part:components/composer.tsx", "part:components/chat.tsx"] }),
      node({ id: "part:components/composer.tsx", kind: "part", title: "Composer", anchor: { files: ["components/composer.tsx"], functions: [] }, depth: 2 }),
      node({ id: "part:components/chat.tsx", kind: "part", title: "Chat view", anchor: { files: screenFiles.filter((f) => f !== "components/composer.tsx"), functions: [] }, children: "unopened", depth: 2 }),
      node({ id: "part:app", kind: "part", title: "Server", anchor: { files: ["app/actions.ts", "app/api/chat/route.ts", "app/api/history/route.ts"], functions: [] } }),
      node({ id: "part:lib/db.ts", kind: "part", title: "Database", anchor: { files: ["lib/db.ts"], functions: [] } }),
      node({
        id: J,
        kind: "journey",
        title: "Sending a message",
        entry: "ui:components/composer.tsx#Composer.submit",
        anchor: { files: [], functions: [SUBMIT, POST, SAVE, HANDLE] },
        parts: ["part:app", "part:components", "part:lib/db.ts"],
        systems: ["Postgres"],
        children: [`${J}#a`, `${J}#b`],
      }),
      node({ id: `${J}#a`, kind: "step", title: "Send", stepKind: "main", anchor: { files: ["components/composer.tsx"], functions: [SUBMIT] }, depth: 2 }),
      node({ id: `${J}#b`, kind: "step", title: "Save", stepKind: "main", anchor: { files: ["app/api/chat/route.ts", "lib/db.ts"], functions: [POST, SAVE] }, systems: ["Postgres"], depth: 2 }),
      node({ id: "system:Postgres", kind: "system", title: "Postgres", anchor: { files: ["lib/db.ts"], functions: [] }, depth: 0 }),
    ].map((n) => [n.id, n]),
  ),
};

describe("understanding views on fixtures/tiny-web", async () => {
  const { facts, snapshot } = await analyze(TINY_WEB, "tiny-web-sha");
  const trees = buildCallTrees(facts, snapshot);
  const signals = computeSignals({ facts, trees });
  const inputs = { repoRoot: TINY_WEB, facts, snapshot, trees, signals, understanding };
  const data = treeData(inputs);

  it("links nodes to parents, colors them by top part and puts steps in the lane holding most of their code", () => {
    const n = data.nodes;
    expect(n["part:components/composer.tsx"]).toMatchObject({ parent: "part:components", color: 0, parts: ["part:components"] });
    expect(n[J]).toMatchObject({ lane: "part:components", color: 0, systems: ["system:Postgres"], entry: "ui:components/composer.tsx#Composer.submit" });
    // One function in each of two parts: the one cited first wins.
    expect(n[`${J}#b`]).toMatchObject({ parent: J, lane: "part:app", color: 1, stepKind: "main" });
    expect(n["system:Postgres"]).toMatchObject({ color: -1, parts: ["part:lib/db.ts"] });
    expect(data.files["lib/db.ts"]).toMatchObject({ systems: ["Postgres"], functions: expect.arrayContaining([SAVE]) });
    expect(data.refs[SAVE]).toMatchObject({ name: "saveChat", file: "lib/db.ts" });
  });

  it("draws the top parts with the calls between them and the systems they use", async () => {
    const graph = (await canvasGraph(inputs, "root"))!;
    expect(graph.nodes.map((g) => [g.id, g.kind])).toEqual([
      ["part:components", "part"],
      ["part:app", "part"],
      ["part:lib/db.ts", "part"],
      ["system:AI model (AI SDK)", "external"],
      ["system:Postgres", "external"],
    ]);
    const edges = graph.edges.map((e) => `${e.from}->${e.to}${e.main ? "" : " (hidden)"}`);
    expect(edges).toEqual(expect.arrayContaining(["part:components->part:app", "part:app->part:lib/db.ts", "part:lib/db.ts->system:Postgres"]));
    expect(graph.edges.filter((e) => e.main).every((e) => e.points !== undefined)).toBe(true);
    expect(await canvasGraph(inputs, "root")).toEqual(graph);
  });

  it("draws a part's children, a leaf part's files, and nothing for unopened or non-part nodes", async () => {
    expect((await canvasGraph(inputs, "part:components"))?.nodes.filter((g) => g.kind === "part").map((g) => [g.id, g.color])).toEqual([
      ["part:components/composer.tsx", 0],
      ["part:components/chat.tsx", 0],
    ]);
    expect((await canvasGraph(inputs, "part:app"))?.nodes.filter((g) => g.kind === "file").map((g) => g.id)).toEqual([
      "file:app/actions.ts",
      "file:app/api/chat/route.ts",
      "file:app/api/history/route.ts",
    ]);
    expect(await canvasGraph(inputs, "part:components/chat.tsx")).toBeUndefined();
    expect(await canvasGraph(inputs, J)).toBeUndefined();
  });

  it("opens a node once, even when asked twice, and redraws it", async () => {
    const opened: string[] = [];
    const open = async (u: Understanding, id: string): Promise<Understanding> => {
      opened.push(id);
      return { ...u, nodes: { ...u.nodes, [id]: { ...u.nodes[id]!, children: "leaf" } } };
    };
    const state = new TreeState({ ...inputs, open });
    expect(await state.canvas("part:components/chat.tsx")).toBeUndefined();
    const [a, b] = await Promise.all([state.open("part:components/chat.tsx"), state.open("part:components/chat.tsx")]);
    expect(opened).toEqual(["part:components/chat.tsx"]);
    expect(a.nodes["part:components/chat.tsx"]?.children).toBe("leaf");
    expect(b).toEqual(a);
    expect((await state.canvas("part:components/chat.tsx"))?.nodes.some((g) => g.id === "file:components/chat.tsx")).toBe(true);
    await expect(state.open("nope")).rejects.toThrow('no node "nope"');
  });
});
