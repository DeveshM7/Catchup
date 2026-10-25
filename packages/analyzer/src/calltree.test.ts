import { describe, expect, it } from "vitest";
import type { CallFact, EntryPointFact } from "./facts.js";
import { buildCallTree, type FunctionTreeNode, type TreeNode } from "./calltree.js";

const entry = (handler: string): EntryPointFact => ({ id: `main:${handler}`, kind: "main", label: handler, handler, file: "a.ts" });
const direct = (from: string, to: string, line = 1): CallFact => ({ from, to, kind: "direct", line, callee: to.split("#")[1] ?? to });
const component = (): string => "c";

function shape(node: TreeNode): string {
  if (node.kind !== "function") return node.kind;
  const name = node.fn.split("#")[1] ?? node.fn;
  const children = node.children.map(shape).join(",");
  return `${name}${node.stop ? `(${node.stop})` : ""}${children ? `[${children}]` : ""}`;
}

describe("buildCallTree", () => {
  it("stops at cycles and shows repeats without re-expanding them", () => {
    const calls = [direct("a.ts#a", "a.ts#b"), direct("a.ts#b", "a.ts#a"), direct("a.ts#a", "a.ts#b", 2)];
    const tree = buildCallTree({ calls }, entry("a.ts#a"), component);
    expect(shape(tree.root)).toBe("a[b[a(cycle)],b(repeat)]");
    expect(tree.functionCount).toBe(2);
  });

  it("respects depth and size limits", () => {
    const chain = [direct("a.ts#a", "a.ts#b"), direct("a.ts#b", "a.ts#c"), direct("a.ts#c", "a.ts#d")];
    expect(shape(buildCallTree({ calls: chain }, entry("a.ts#a"), component, { maxDepth: 2, maxFunctions: 100 }).root)).toBe(
      "a[b[c(depth)]]",
    );
    expect(shape(buildCallTree({ calls: chain }, entry("a.ts#a"), component, { maxDepth: 10, maxFunctions: 2 }).root)).toBe(
      "a[b[c(size)]]",
    );
  });

  it("records external systems, writes and dynamic calls", () => {
    const calls: CallFact[] = [
      { from: "a.ts#a", to: null, kind: "external", target: "ioredis", line: 1, callee: "redis.set" },
      { from: "a.ts#a", to: null, kind: "external", target: "zod", line: 2, callee: "z.parse" },
      { from: "a.ts#a", to: null, kind: "dynamic", line: 3, callee: "handlers[k]" },
    ];
    const tree = buildCallTree({ calls }, entry("a.ts#a"), component);
    const [redis, zod] = (tree.root as FunctionTreeNode).children;
    expect(redis).toMatchObject({ kind: "external", system: "Redis", writes: true });
    expect(zod).toMatchObject({ kind: "external", package: "zod" });
    expect(zod).not.toHaveProperty("system");
    expect(tree.systems).toEqual(["Redis"]);
    expect(tree.partial).toBe(true);
    expect(tree.dynamicCalls).toEqual([{ fn: "a.ts#a", line: 3, callee: "handlers[k]" }]);
  });
});
