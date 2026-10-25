import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCommit, withWorktree } from "../../history/src/index.js";
import { analyze, buildCallTrees, flowFamilies, PKG_PREFIX } from "./index.js";

const UMAMI = fileURLToPath(new URL("../../../fixtures/umami", import.meta.url));

describe.skipIf(!existsSync(UMAMI))("analyze fixtures/umami (smoke)", () => {
  it("produces a sensible map", { timeout: 120_000 }, async () => {
    const { facts, snapshot } = await withWorktree(UMAMI, resolveCommit(UMAMI, "HEAD"), (dir) => analyze(dir, "smoke"));
    const files = new Set(facts.files.map((f) => f.path));
    const functionIds = new Set(facts.functions.map((f) => f.id));

    expect(snapshot.components.length).toBeGreaterThanOrEqual(10);
    expect(snapshot.components.length).toBeLessThanOrEqual(25);
    expect(facts.functions.length).toBeGreaterThan(0);
    for (const { from, to } of facts.imports) {
      expect(files.has(from)).toBe(true);
      expect(to.startsWith(PKG_PREFIX) || files.has(to)).toBe(true);
    }
    for (const fn of facts.functions) expect(files.has(fn.file)).toBe(true);
    expect(snapshot.edges.length).toBeGreaterThan(20);
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ from: "src/app/api", to: "src/lib" }));
    expect(snapshot.externals.map((e) => e.name)).toEqual(expect.arrayContaining(["Postgres", "ClickHouse", "Redis", "Kafka"]));

    expect(facts.entryPoints.length).toBeGreaterThan(150);
    for (const call of facts.calls) if (call.kind === "direct") expect(functionIds.has(call.to ?? "")).toBe(true);
    const trees = buildCallTrees(facts, snapshot);
    const login = trees.find((t) => t.entryPoint.label === "POST /api/auth/login");
    const send = trees.find((t) => t.entryPoint.label === "POST /api/send");
    expect(login?.systems).toEqual(expect.arrayContaining(["Postgres", "Redis"]));
    expect(send?.systems).toEqual(expect.arrayContaining(["ClickHouse", "Kafka", "Postgres", "Redis"]));
    const loginTop = login?.root.children.flatMap((c) => (c.kind === "function" ? [c.fn] : [])) ?? [];
    expect(loginTop).toEqual(
      expect.arrayContaining(["src/queries/prisma/user.ts#getUserByUsername", "src/lib/auth.ts#saveAuth", "src/queries/prisma/team.ts#getAllUserTeams"]),
    );

    // D32: the top two families are "collect events" and "query stats".
    const [collect, query] = flowFamilies(trees);
    expect(collect?.members).toEqual(expect.arrayContaining(["http:POST /api/send", "http:POST /api/batch"]));
    expect(query?.members).toContain("http:GET /api/websites/[websiteId]/metrics");
    expect(query?.members.length).toBeGreaterThan(30);
  });
});
