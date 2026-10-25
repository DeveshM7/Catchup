import { describe, expect, it } from "vitest";
import type { NodeView, TreeData } from "./shared/types.js";
import { answerScope, boxText, codeName, compactStep, folderName, inScope, panelText, visibleChildren } from "./shared/view.js";
import { parseAsk } from "./server/server.js";

const node = (id: string, extra: Partial<NodeView> = {}): NodeView => ({
  id, kind: "step", title: `T ${id}`, short: `S ${id}`, long: `L ${id}`, depth: 2, children: "leaf", parent: null,
  color: 0, parts: [], systems: [], files: ["a/x.ts"], functions: [`a/x.ts#${id}`], ...extra,
});

const data = (nodes: NodeView[]): TreeData => ({
  repo: "r", sha: "s", model: "m", summary: "", parts: [], journeys: [], systems: [], otherFlows: [], extras: null,
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), files: {},
  refs: Object.fromEntries(nodes.flatMap((n) => n.functions.map((f) => [f, { id: f, name: f.split("#")[1] ?? f, file: "a/x.ts", startLine: 1, endLine: 2, component: "a" }]))),
});

describe("familiarity (D40)", () => {
  const steps = [node("main"), node("check", { stepKind: "check" }), node("err", { stepKind: "error" })];
  const journey = node("j", { kind: "journey", children: steps.map((s) => s.id) });
  const d = data([journey, ...steps]);

  it("hides error paths only for newcomers", () => {
    expect(visibleChildren(journey, d, "new")).toEqual({ shown: [steps[0], steps[1]], hidden: 1 });
    expect(visibleChildren(journey, d, "expert").shown).toHaveLength(3);
  });

  it("picks long, short or no text, and code names for experts", () => {
    const step = steps[0]!;
    expect([panelText(step, "new"), panelText(step, "familiar"), panelText(step, "expert")]).toEqual(["L main", "S main", ""]);
    expect(boxText(step, d, "expert")).toBe("main()");
    expect(compactStep(steps[1]!, "new")).toBe(false);
    expect(compactStep(steps[1]!, "familiar")).toBe(true);
  });

  it("names a part by the folder that holds its files", () => {
    expect(folderName(["lib/db/a.ts", "lib/db/b/c.ts"])).toBe("lib/db/");
    expect(folderName(["one.ts"])).toBe("one.ts");
    expect(folderName(["app/a.ts", "app/b.ts", "lib/c.ts", "proxy.ts"])).toBe("app/, ./, lib/");
  });

  it("names parts carved out of one folder by their busiest file, so siblings never share a name", () => {
    const part = (id: string, files: string[], extra: Partial<NodeView> = {}): NodeView =>
      node(id, { kind: "part", files, functions: [], parent: "p", ...extra });
    const parent = part("p", ["c/chat/a.tsx", "c/chat/b.tsx", "c/chat/c.tsx", "lib/db/q.ts", "lib/db/s.ts"], { parent: null, children: ["x", "y", "z"] });
    const x = part("x", ["c/chat/a.tsx", "c/chat/b.tsx"]);
    const y = part("y", ["c/chat/c.tsx"]);
    const z = part("z", ["lib/db/q.ts", "lib/db/s.ts"]);
    const d = { ...data([parent, x, y, z]), parts: ["p"], files: { "c/chat/b.tsx": { path: "c/chat/b.tsx", loc: 1, flows: 3, systems: [], functions: [] } } };
    expect([x, y, z].map((n) => codeName(n, d))).toEqual(["c/chat/b.tsx +1 file", "c/chat/c.tsx", "lib/db/"]);
    expect(codeName(parent, d)).toBe("c/, lib/");
  });
});

describe("Ask (Build 5)", () => {
  it("lights cited files, the files of cited functions and boxes, cited systems, and a cited journey's steps", () => {
    const steps = [node("s1", { files: ["lib/db.ts"] }), node("s2", { files: ["app/route.ts"] })];
    const journey = node("j", { kind: "journey", children: ["s1", "s2"], files: ["app/route.ts", "lib/db.ts"] });
    const pg = node("system:Postgres", { kind: "system", files: ["lib/db.ts"] });
    const d = data([journey, pg, ...steps]);
    const scope = answerScope({ answer: "a", nodes: ["j", "system:Postgres"], functions: ["lib/ai.ts#run"], files: ["README.md"], steps: [] }, d);
    expect([...scope.files].sort()).toEqual(["README.md", "app/route.ts", "lib/ai.ts", "lib/db.ts"]);
    expect([...scope.systems]).toEqual(["system:Postgres"]);
    expect([...scope.nodes!].sort()).toEqual(["j", "s1", "s2", "system:Postgres"]);
    expect(inScope(scope, "s2", [])).toBe(true);
  });

  it("accepts a question with an optional box and history, and rejects empty ones", () => {
    expect(parseAsk(JSON.stringify({ question: "  Why?  ", node: "part:lib", history: [{ question: "q", answer: "a" }, { bad: 1 }] }))).toEqual({
      question: "Why?",
      node: "part:lib",
      history: [{ question: "q", answer: "a" }],
    });
    expect(parseAsk(JSON.stringify({ question: "Why?", node: "" }))).toEqual({ question: "Why?" });
    expect(() => parseAsk(JSON.stringify({ question: "   " }))).toThrow(/question must be/);
    expect(() => parseAsk("not json")).toThrow();
  });
});

