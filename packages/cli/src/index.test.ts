import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, type Snapshot } from "@catchup/analyzer";
import { formatSummary, packageName, usage } from "./index.js";
import { formatTree } from "./tree.js";

const snapshot: Snapshot = {
  sha: "abc",
  components: [
    { id: "src/api", name: "api", kind: "folder", files: ["a.ts", "b.ts"], loc: 10, functionCount: 3, packages: [] },
    { id: "src/db", name: "db", kind: "folder", files: ["c.ts"], loc: 5, functionCount: 1, packages: ["pg"] },
  ],
  edges: [{ from: "src/api", to: "src/db", weight: 2 }],
  externals: [{ id: "ext:postgres", name: "Postgres", packages: ["pg"], usedBy: ["src/db"] }],
  summary: { files: 3, functions: 4, imports: 3, components: 2, externals: 1 },
};

describe("cli", () => {
  it("exposes its package name and usage", () => {
    expect(packageName).toBe("cli");
    expect(usage()).toContain("init");
  });

  it("formats a component table, largest first", () => {
    const lines = formatSummary(snapshot).split("\n");
    expect(lines[0]).toMatch(/^Component\s+Files\s+Functions\s+Uses most\s+External systems$/);
    expect(lines[1]).toMatch(/^src\/api\s+2\s+3\s+src\/db \(2\)$/);
    expect(lines[2]).toMatch(/^src\/db\s+1\s+1\s+Postgres$/);
    expect(lines).toContain("  Postgres: pg ← src/db");
    expect(lines.at(-1)).toBe("2 components, 3 files, 4 functions, 3 imports");
  });

  it("prints a journey across the client → server boundary and back", { timeout: 30_000 }, async () => {
    const repo = fileURLToPath(new URL("../../../fixtures/tiny-web", import.meta.url));
    const { facts, snapshot: tinyWeb } = await analyze(repo, "test");
    const tree = buildCallTrees(facts, tinyWeb).find((t) => t.entryPoint.label === "Composer onSubmit");
    if (!tree) throw new Error("no Composer onSubmit tree");
    const text = formatTree(tree, { showNoise: true, functions: new Map(facts.functions.map((f) => [f.id, f])) });
    expect(text).toContain("POST  app/api/chat/route.ts:4  {.}  [request → http:POST /api/chat]");
    expect(text).toContain('handlePart  components/parts.ts:1  {.}  [if, message "data-title"]');
  });
});
