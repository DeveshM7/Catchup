import { describe, expect, it } from "vitest";
import type { CallTree, FunctionTreeNode, TreeNode } from "./calltree.js";
import type { FunctionFact } from "./facts.js";
import { scoreTree } from "./scoring.js";

const fact = (id: string, lines: number): FunctionFact => ({ id, file: id.split("#")[0] ?? id, name: id.split("#")[1] ?? id, startLine: 1, endLine: lines, hash: "h" });
const fnNode = (fn: string, component: string, children: TreeNode[] = [], extra: Partial<FunctionTreeNode> = {}): FunctionTreeNode => ({
  kind: "function",
  fn,
  component,
  children,
  importance: "normal",
  ...extra,
});

function score(root: FunctionTreeNode, facts: FunctionFact[]): FunctionTreeNode {
  const tree: CallTree = {
    entryPoint: { id: "e", kind: "main", label: "e", handler: root.fn, file: "x" },
    root,
    partial: false,
    dynamicCalls: [],
    functionCount: 0,
    systems: [],
  };
  return scoreTree(tree, { functions: new Map(facts.map((f) => [f.id, f])) }).root;
}

describe("scoreTree (D21)", () => {
  it("marks boundary crossings and external-system calls important, helpers noise", () => {
    const root = fnNode("a.ts#handle", "api", [
      fnNode("b.ts#loadUser", "db", [fnNode("b.ts#buildQuery", "db", [fnNode("b.ts#q2", "db")])]),
      fnNode("c.ts#save", "api", [{ kind: "external", package: "pg", system: "Postgres", callee: "pool.query", site: { line: 1 }, importance: "normal" }]),
      fnNode("d.ts#logError", "util"),
      fnNode("d.ts#isEmail", "util"),
      fnNode("d.ts#pad", "util"),
      fnNode("e.ts#cleanup", "api", [], { site: { line: 9, conditional: true, onError: true } }),
      { kind: "external", package: "zod", callee: "z.parse", site: { line: 2 }, importance: "normal" },
    ]);
    const facts = [fact("b.ts#loadUser", 20), fact("b.ts#buildQuery", 20), fact("b.ts#q2", 20), fact("c.ts#save", 10), fact("d.ts#pad", 3), fact("e.ts#cleanup", 20)];
    const scored = score(root, facts);
    expect(scored.children.map((c) => c.importance)).toEqual(["important", "important", "noise", "noise", "noise", "noise", "noise"]);
    const loadUser = scored.children[0] as FunctionTreeNode;
    expect(loadUser.children[0]?.importance).toBe("normal");
  });

  it("does not treat names that merely start with a noise word as noise", () => {
    const scored = score(fnNode("a.ts#h", "api", [fnNode("b.ts#login", "auth", [fnNode("b.ts#x", "auth")])]), [fact("b.ts#login", 20), fact("b.ts#x", 20)]);
    expect(scored.children[0]?.importance).toBe("important");
  });
});
