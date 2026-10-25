import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, computeSignals } from "@catchup/analyzer";
import { buildMap, treeView } from "./server/data.js";
import { sourceOf } from "./server/server.js";

const TINY = fileURLToPath(new URL("../../../fixtures/tiny", import.meta.url));
const grouping = { splitAbove: 80, mergeBelow: 2, maxComponents: 25 };

describe("dashboard data on fixtures/tiny", async () => {
  const { facts, snapshot } = await analyze(TINY, "tiny-sha", { grouping });
  const trees = buildCallTrees(facts, snapshot);
  const inputs = { repoRoot: TINY, facts, snapshot, trees, signals: computeSignals({ facts, trees }) };

  it("puts every component and external system on the full map", async () => {
    const data = await buildMap(inputs);
    const ids = data.map.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([...snapshot.components.map((c) => c.id), ...snapshot.externals.map((e) => e.id)].sort());
    expect(data.entries.map((e) => e.label).sort()).toEqual(["GET /api/login", "POST /api/login", "POST /charge", "POST /login"]);
  });

  it("sends call trees with function refs and source text", () => {
    const tree = trees.find((t) => t.entryPoint.label === "POST /api/login");
    if (!tree) throw new Error("missing tree");
    const view = treeView(tree, facts, snapshot);
    if (view.root.kind !== "function") throw new Error("root is not a function");
    expect(view.root.fn.id).toBe("src/app/api/login/route.ts#POST");
    const login = view.root.children.find((c) => c.kind === "function" && c.fn.id === "src/auth/login.ts#login");
    expect(login?.kind === "function" && login.fn.component).toBe("src/auth");
    const source = sourceOf(inputs, "src/auth/login.ts#login");
    expect(source?.text).toContain("login");
    expect(sourceOf(inputs, "nope#x")).toBeUndefined();
  });
});
