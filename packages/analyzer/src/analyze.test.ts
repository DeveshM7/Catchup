import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, type FunctionTreeNode, type TreeNode } from "./index.js";

const TINY = fileURLToPath(new URL("../../../fixtures/tiny", import.meta.url));
const grouping = { splitAbove: 80, mergeBelow: 2, maxComponents: 25 };

/** `importance name [flags]`, indented by depth. */
function render(node: TreeNode, depth = 0): string[] {
  const flags = [
    node.site?.conditional ? "if" : "",
    node.site?.parallel ? "parallel" : "",
    node.site?.onError ? "catch" : "",
    node.kind === "function" && node.stop ? node.stop : "",
  ].filter(Boolean);
  const label = node.kind === "function" ? node.fn : node.kind === "external" ? `ext:${node.system ?? node.package} ${node.callee}` : `dynamic ${node.callee}`;
  const line = `${"  ".repeat(depth)}${node.importance} ${label}${flags.length ? ` [${flags.join(",")}]` : ""}`;
  return [line, ...(node.kind === "function" ? node.children.flatMap((c) => render(c, depth + 1)) : [])];
}

describe("analyze fixtures/tiny (known answers)", async () => {
  const { facts, snapshot } = await analyze(TINY, "tiny-sha", { grouping });

  it("lists source files, skipping tests, .d.ts and configs", () => {
    expect(facts.files.map((f) => f.path)).toEqual([
      "packages/sdk/src/index.ts",
      "src/api/routes.ts",
      "src/api/server.ts",
      "src/app/api/login/route.ts",
      "src/auth/login.ts",
      "src/auth/session.ts",
      "src/billing/charge.ts",
      "src/db/client.ts",
      "src/db/types.ts",
      "src/db/users.ts",
      "src/index.ts",
      "src/utils/crypto.ts",
      "src/utils/events.ts",
      "src/utils/libs.ts",
      "src/utils/log.ts",
      "src/utils/request.ts",
    ]);
    expect(facts.files.find((f) => f.path === "src/auth/login.ts")).toEqual({ path: "src/auth/login.ts", lang: "typescript", loc: 17, side: "server" });
  });

  it("finds named functions only", () => {
    expect(facts.functions.map((f) => [f.id, f.startLine, f.endLine])).toEqual([
      ["packages/sdk/src/index.ts#ping", 1, 3],
      ["src/api/routes.ts#listUsers", 4, 7],
      ["src/api/server.ts#createServer", 5, 11],
      ["src/app/api/login/route.ts#GET", 25, 30],
      ["src/app/api/login/route.ts#POST", 9, 23],
      ["src/app/api/login/route.ts#full", 36, 38],
      ["src/app/api/login/route.ts#handlers.a", 6, 6],
      ["src/app/api/login/route.ts#handlers.b", 6, 6],
      ["src/app/api/login/route.ts#isValidBody", 40, 42],
      ["src/app/api/login/route.ts#quick", 32, 34],
      ["src/auth/login.ts#Session.start", 14, 16],
      ["src/auth/login.ts#login", 5, 11],
      ["src/auth/session.ts#createSession", 3, 5],
      ["src/billing/charge.ts#default", 3, 6],
      ["src/db/users.ts#findUser", 4, 7],
      ["src/db/users.ts#repo.remove", 13, 13],
      ["src/db/users.ts#repo.save", 10, 12],
      ["src/index.ts#main", 3, 5],
      ["src/utils/crypto.ts#hashPassword", 3, 8],
      ["src/utils/crypto.ts#hashPassword.inner", 4, 6],
      ["src/utils/events.ts#audit", 3, 6],
      ["src/utils/events.ts#notify", 8, 10],
      ["src/utils/libs.ts#useCounter", 13, 16],
      ["src/utils/libs.ts#whoAmI", 8, 11],
      ["src/utils/log.ts#log", 1, 3],
      ["src/utils/request.ts#parseInput", 3, 7],
      ["src/utils/request.ts#reject", 9, 11],
      ["src/utils/request.ts#runEither", 13, 15],
    ]);
  });

  it("resolves @/ aliases without baseUrl, names packages, drops type-only and node: imports", () => {
    expect(facts.imports).toEqual([
      { from: "src/api/routes.ts", to: "src/db/users.ts" },
      { from: "src/api/server.ts", to: "pkg:express" },
      { from: "src/api/server.ts", to: "src/auth/login.ts" },
      { from: "src/api/server.ts", to: "src/billing/charge.ts" },
      { from: "src/app/api/login/route.ts", to: "src/auth/login.ts" },
      { from: "src/app/api/login/route.ts", to: "src/utils/events.ts" },
      { from: "src/app/api/login/route.ts", to: "src/utils/log.ts" },
      { from: "src/app/api/login/route.ts", to: "src/utils/request.ts" },
      { from: "src/auth/login.ts", to: "src/auth/session.ts" },
      { from: "src/auth/login.ts", to: "src/db/users.ts" },
      { from: "src/auth/login.ts", to: "src/utils/crypto.ts" },
      { from: "src/auth/session.ts", to: "src/db/client.ts" },
      { from: "src/billing/charge.ts", to: "pkg:stripe" },
      { from: "src/db/client.ts", to: "pkg:pg" },
      { from: "src/db/users.ts", to: "src/db/client.ts" },
      { from: "src/index.ts", to: "src/api/server.ts" },
      { from: "src/utils/events.ts", to: "src/db/client.ts" },
      { from: "src/utils/libs.ts", to: "pkg:drizzle-orm/postgres-js" },
      { from: "src/utils/libs.ts", to: "pkg:next-auth" },
      { from: "src/utils/libs.ts", to: "pkg:react" },
    ]);
  });

  it("groups components, merging tiny folders into src", () => {
    expect(snapshot.components.map((c) => [c.id, c.kind, c.files.length, c.functionCount, c.packages])).toEqual([
      ["packages/sdk", "package", 1, 1, []],
      ["src", "root", 3, 9, ["stripe"]],
      ["src/api", "folder", 2, 2, ["express"]],
      ["src/auth", "folder", 2, 3, []],
      ["src/db", "folder", 3, 3, ["pg"]],
      ["src/utils", "folder", 5, 10, ["drizzle-orm/postgres-js", "next-auth", "react"]],
    ]);
  });

  it("rolls imports up to weighted component edges", () => {
    expect(snapshot.edges).toEqual([
      { from: "src", to: "src/api", weight: 1 },
      { from: "src", to: "src/auth", weight: 1 },
      { from: "src", to: "src/utils", weight: 3 },
      { from: "src/api", to: "src", weight: 1 },
      { from: "src/api", to: "src/auth", weight: 1 },
      { from: "src/api", to: "src/db", weight: 1 },
      { from: "src/auth", to: "src/db", weight: 2 },
      { from: "src/auth", to: "src/utils", weight: 1 },
      { from: "src/utils", to: "src/db", weight: 1 },
    ]);
  });

  it("detects external systems", () => {
    expect(snapshot.externals).toEqual([
      { id: "ext:postgres", name: "Postgres", packages: ["drizzle-orm/postgres-js", "pg"], usedBy: ["src/db", "src/utils"] },
      { id: "ext:stripe", name: "Stripe", packages: ["stripe"], usedBy: ["src"] },
    ]);
  });

  it("detects Next.js route handlers and Express-style routes as entry points", () => {
    expect(facts.entryPoints).toEqual([
      { id: "http:GET /api/login", kind: "http", label: "GET /api/login", handler: "src/app/api/login/route.ts#GET", file: "src/app/api/login/route.ts" },
      { id: "http:POST /api/login", kind: "http", label: "POST /api/login", handler: "src/app/api/login/route.ts#POST", file: "src/app/api/login/route.ts" },
      { id: "http:POST /charge", kind: "http", label: "POST /charge", handler: "src/billing/charge.ts#default", file: "src/billing/charge.ts" },
      { id: "http:POST /login", kind: "http", label: "POST /login", handler: "src/auth/login.ts#login", file: "src/auth/login.ts" },
    ]);
  });

  it("resolves calls: direct, external through local wrappers, lookup tables; skips built-ins", () => {
    const of = (fn: string) => facts.calls.filter((c) => c.from === fn).map((c) => {
      const rest: Partial<typeof c> = { ...c };
      delete rest.from;
      return rest;
    });
    expect(of("src/app/api/login/route.ts#POST")).toEqual([
      { to: "src/app/api/login/route.ts#isValidBody", kind: "direct", line: 11, callee: "isValidBody" },
      { to: "src/auth/login.ts#login", kind: "direct", line: 15, callee: "login" },
      { to: "src/utils/events.ts#audit", kind: "direct", line: 16, callee: "audit", parallel: true },
      { to: "src/utils/events.ts#notify", kind: "direct", line: 16, callee: "notify", parallel: true },
      { to: "src/app/api/login/route.ts#handlers.a", kind: "direct", line: 17, callee: "handlers[body.kind]", conditional: true, oneOf: true },
      { to: "src/app/api/login/route.ts#handlers.b", kind: "direct", line: 17, callee: "handlers[body.kind]", conditional: true, oneOf: true },
      { to: "src/utils/log.ts#log", kind: "direct", line: 20, callee: "log", conditional: true, onError: true },
    ]);
    expect(of("src/auth/login.ts#login").map((c) => [c.to, c.conditional ?? false])).toEqual([
      ["src/db/users.ts#findUser", false],
      ["src/utils/crypto.ts#hashPassword", true],
      ["src/auth/session.ts#createSession", false],
    ]);
    expect(of("src/db/users.ts#repo.remove")).toEqual([{ to: null, kind: "external", target: "pg", line: 13, callee: "pool.query" }]);
    expect(of("src/billing/charge.ts#default").map((c) => [c.target, c.callee])).toEqual([
      ["stripe", "new Stripe"],
      ["stripe", "stripe.charges.create"],
    ]);
    expect(of("src/api/server.ts#createServer").map((c) => [c.target ?? c.to, c.callee, c.passed ?? false])).toEqual([
      ["express", "express", false],
      ["src/auth/login.ts#login", "login", true],
      ["express", "app.post", false],
      ["src/billing/charge.ts#default", "charge", true],
      ["express", "app.post", false],
    ]);
    expect(of("src/utils/crypto.ts#hashPassword")).toEqual([
      { to: "src/utils/crypto.ts#hashPassword.inner", kind: "direct", line: 7, callee: "inner" },
    ]);
    expect(of("src/utils/log.ts#log")).toEqual([]);
  });

  it("builds and scores the POST /api/login call tree", () => {
    const tree = buildCallTrees(facts, snapshot).find((t) => t.entryPoint.label === "POST /api/login");
    if (!tree) throw new Error("missing tree");
    expect(render(tree.root as FunctionTreeNode)).toEqual([
      "normal src/app/api/login/route.ts#POST",
      "  noise src/app/api/login/route.ts#isValidBody",
      "  important src/auth/login.ts#login",
      "    important src/db/users.ts#findUser",
      "      important ext:Postgres pool.query",
      "    important src/utils/crypto.ts#hashPassword [if]",
      "      noise src/utils/crypto.ts#hashPassword.inner",
      "    important src/auth/session.ts#createSession",
      "      important ext:Postgres pool.query",
      "  important src/utils/events.ts#audit [parallel]",
      "    important ext:Postgres pool.query",
      "  noise src/utils/events.ts#notify [parallel]",
      "  noise src/app/api/login/route.ts#handlers.a [if]",
      "  noise src/app/api/login/route.ts#handlers.b [if]",
      "  noise src/utils/log.ts#log [if,catch]",
    ]);
    expect(tree.partial).toBe(false);
    expect(tree.systems).toEqual(["Postgres"]);
    expect(tree.functionCount).toBe(12);
  });

  it("treats values unpacked from a package call as that package's (D29)", () => {
    const of = (fn: string) => facts.calls.filter((c) => c.from === fn).map((c) => [c.kind, c.target ?? c.to, c.callee]);
    expect(of("src/utils/libs.ts#whoAmI")).toEqual([
      ["external", "next-auth", "auth"],
      ["external", "drizzle-orm/postgres-js", "db.select"],
      ["external", "drizzle-orm/postgres-js", "db.select().from"],
    ]);
    expect(of("src/utils/libs.ts#useCounter")).toEqual([
      ["external", "react", "useState"],
      ["external", "react", "setCount"],
    ]);
  });

  it("follows function values: returned closures, callbacks, passed functions; flags the rest as dynamic", () => {
    const of = (fn: string) => facts.calls.filter((c) => c.from === fn).map((c) => [c.kind, c.to ?? c.callee, c.passed ?? false]);
    expect(of("src/app/api/login/route.ts#GET")).toEqual([
      ["direct", "src/utils/request.ts#parseInput", false],
      ["callback", "error", false],
      ["dynamic", "registry.get(request.method)", false],
      ["direct", "src/app/api/login/route.ts#quick", false],
      ["direct", "src/app/api/login/route.ts#full", true],
      ["direct", "src/utils/request.ts#runEither", false],
    ]);
    expect(of("src/utils/request.ts#parseInput")).toEqual([["direct", "src/utils/request.ts#reject", false]]);
    expect(of("src/utils/request.ts#runEither")).toEqual([["callback", "queries[key]", false]]);
    const tree = buildCallTrees(facts, snapshot).find((t) => t.entryPoint.label === "GET /api/login");
    expect(tree?.dynamicCalls).toEqual([{ fn: "src/app/api/login/route.ts#GET", line: 28, callee: "registry.get(request.method)" }]);
  });

  it("is deterministic: a second run gives identical JSON", async () => {
    const again = await analyze(TINY, "tiny-sha", { grouping });
    expect(JSON.stringify(again)).toBe(JSON.stringify({ facts, snapshot }));
  });
});
