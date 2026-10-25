import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { analyze, buildCallTrees, type CallTree, type Facts, type Snapshot, type TreeNode } from "./index.js";

const REPO = fileURLToPath(new URL("../../../fixtures/tiny-cli", import.meta.url));

const fnsOf = (node: TreeNode): string[] => (node.kind === "function" ? [node.fn, ...node.children.flatMap(fnsOf)] : []);

describe("analyze fixtures/tiny-cli (known answers, Build 1)", () => {
  let facts: Facts;
  let snapshot: Snapshot;
  let trees: CallTree[];
  beforeAll(async () => {
    ({ facts, snapshot } = await analyze(REPO, "test"));
    trees = buildCallTrees(facts, snapshot);
  });
  const tree = (label: string): CallTree => {
    const found = trees.find((t) => t.entryPoint.label === label);
    if (!found) throw new Error(`no tree ${label}`);
    return found;
  };

  it("finds the bin, its commands and the library exports", () => {
    expect(facts.entryPoints.map((e) => [e.id, e.handler])).toEqual([
      ["cli:$ tc", "src/cli.ts#(module)"],
      ["cli:command [...files]", "src/cli-main.ts#main.command:[...files]"],
      ["cli:command clean", "src/clean.ts#clean"],
      ["library:tiny-cli: build()", "src/build.ts#build"],
      ["library:tiny-cli: defineConfig()", "src/config.ts#defineConfig"],
      ["library:tiny-cli: init()", "src/init.ts#init"],
    ]);
  });

  it("runs the bin's top-level code and reaches each command through main", () => {
    expect(fnsOf(tree("$ tc").root)).toEqual([
      "src/cli.ts#(module)",
      "src/cli-main.ts#main",
      "src/cli-main.ts#main.command:[...files]",
      "src/build.ts#build",
      "src/config.ts#loadConfig",
      "src/dts.ts#(module)",
      "src/dts.ts#on:message",
      "src/dts.ts#emitTypes",
      "src/dts.ts#Pool.add",
      "src/clean.ts#clean",
      "src/clean.ts#removeDir",
      "src/errors.ts#handleError",
    ]);
  });

  it("records the command closure as passed, so it runs only when the command is picked", () => {
    const main = facts.calls.filter((c) => c.from === "src/cli-main.ts#main" && c.kind === "direct");
    expect(main.map((c) => [c.to, c.passed, c.conditional])).toEqual([
      ["src/cli-main.ts#main.command:[...files]", true, true],
      ["src/clean.ts#clean", true, true],
    ]);
  });

  it("treats a value from `await import(\"pkg\")` as that package's", () => {
    const watch = facts.calls.find((c) => c.from === "src/build.ts#build" && c.callee === "watch");
    expect(watch).toMatchObject({ kind: "external", target: "chokidar", conditional: true });
    expect(tree("tiny-cli: build()").partial).toBe(false);
  });

  it("follows `new Worker(<our file>)` into that file's top-level code (D52)", () => {
    const worker = facts.calls.find((c) => c.callee === "new Worker(src/dts.ts)");
    expect(worker).toMatchObject({ from: "src/build.ts#build", to: "src/dts.ts#(module)", kind: "direct", passed: true });
  });

  it("records nothing for `new` on our class without a constructor; the TypeScript compiler is a tool (D52, D53)", () => {
    const emit = facts.calls.filter((c) => c.from === "src/dts.ts#emitTypes");
    expect(emit.map((c) => c.to ?? c.target)).toEqual(["src/dts.ts#Pool.add", "typescript", "typescript"]);
    expect(snapshot.externals).toEqual([{ id: "ext:typescript", name: "TypeScript compiler", kind: "tool", packages: ["typescript"], usedBy: ["src"] }]);
    expect(tree("$ tc").partial).toBe(false);
    expect(tree("$ tc").systems).toEqual(["TypeScript compiler"]);
  });
});
