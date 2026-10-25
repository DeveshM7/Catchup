import { describe, expect, it } from "vitest";
import type { CallTree, FunctionTreeNode } from "./calltree.js";
import { flowFamilies, overlap } from "./families.js";

const fn = (id: string, component: string, children: FunctionTreeNode[] = []): FunctionTreeNode => ({
  kind: "function",
  fn: id,
  component,
  children,
  importance: "normal",
});

function tree(label: string, calls: string[], systems: string[] = []): CallTree {
  const root = fn(`routes/${label}.ts#handler`, "api", calls.map((c) => fn(c, c.split("/")[0]!)));
  return {
    entryPoint: { id: `http:${label}`, kind: "http", label, handler: root.fn, file: `routes/${label}.ts` },
    root,
    partial: false,
    dynamicCalls: [],
    functionCount: calls.length + 1,
    systems,
  };
}

describe("flowFamilies (D32)", () => {
  it("measures overlap as shared / union", () => {
    expect(overlap(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(overlap(new Set(), new Set())).toBe(0);
  });

  it("groups routes that run the same code and ranks the biggest flow first", () => {
    const stats = ["db/q.ts#query", "db/q.ts#parse", "lib/auth.ts#check", "lib/cache.ts#get", "lib/fmt.ts#out"];
    const families = flowFamilies([
      tree("GET /vote", ["lib/auth.ts#check", "db/q.ts#vote"], ["Postgres"]),
      tree("GET /stats/a", stats, ["Postgres", "Redis"]),
      tree("GET /stats/b", [...stats, "lib/fmt.ts#extra"], ["Postgres", "Redis"]),
      tree("GET /stats/c", stats.slice(0, 4), ["Postgres", "Redis"]),
      tree("POST /chat", ["ai/model.ts#stream", "ai/tools.ts#write", "db/q.ts#save", "lib/auth.ts#check"], ["AI", "Postgres", "Redis"]),
    ]);
    expect(families.map((f) => f.members.length)).toEqual([1, 3, 1]);
    expect(families[0]!.representative).toBe("http:POST /chat");
    const statsFamily = families[1]!;
    expect(statsFamily.id).toBe("http:GET /stats/a");
    expect(statsFamily.representative).toBe("http:GET /stats/a");
    expect(statsFamily.members).toContain("http:GET /stats/c");
    expect(families[2]!.members).toEqual(["http:GET /vote"]);
  });

  it("gives the same answer whatever order the trees come in", () => {
    const trees = [tree("A", ["x/a.ts#1", "x/a.ts#2"]), tree("B", ["x/a.ts#1", "x/a.ts#2", "x/a.ts#3"]), tree("C", ["y/b.ts#1"])];
    expect(flowFamilies([...trees].reverse())).toEqual(flowFamilies(trees));
  });
});
