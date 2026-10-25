import { describe, expect, it } from "vitest";
import type { FunctionFact } from "./facts.js";
import { appRouteUrl, detectEntryPoints, pagesApiUrl } from "./entrypoints.js";

const fn = (file: string, name: string): FunctionFact => ({ id: `${file}#${name}`, file, name, startLine: 1, endLine: 2, hash: "h" });

describe("Next.js URLs", () => {
  it.each([
    ["src/app/api/auth/login/route.ts", "/api/auth/login"],
    ["src/app/(collect)/p/[slug]/route.ts", "/p/[slug]"],
    ["app/@modal/x/route.js", "/x"],
    ["src/app/route.ts", "/"],
    ["src/app/_lib/route.ts", undefined],
    ["src/app/api/page.tsx", undefined],
  ])("app router %s → %s", (file, url) => {
    expect(appRouteUrl(file)).toBe(url);
  });

  it.each([
    ["pages/api/users/[id].ts", "/api/users/[id]"],
    ["src/pages/api/index.ts", "/api"],
    ["pages/about.tsx", undefined],
  ])("pages router %s → %s", (file, url) => {
    expect(pagesApiUrl(file)).toBe(url);
  });
});

describe("detectEntryPoints", () => {
  it("finds exported HTTP method handlers and pages/api default exports", () => {
    const files = ["src/app/api/x/route.ts", "pages/api/y.ts"];
    const functions = [fn(files[0] ?? "", "GET"), fn(files[0] ?? "", "helper"), fn(files[1] ?? "", "handler")];
    const found = detectEntryPoints({ files, functions, defaultExportName: () => "handler", calledFunctions: new Set() });
    expect(found.map((e) => [e.label, e.handler])).toEqual([
      ["ANY /api/y", "pages/api/y.ts#handler"],
      ["GET /api/x", "src/app/api/x/route.ts#GET"],
    ]);
  });

  it("falls back to top-level functions nothing calls when no framework matches", () => {
    const functions = [fn("cli.ts", "main"), fn("cli.ts", "run"), fn("cli.ts", "K.method")];
    const found = detectEntryPoints({
      files: ["cli.ts"],
      functions,
      defaultExportName: () => undefined,
      calledFunctions: new Set(["cli.ts#run"]),
    });
    expect(found.map((e) => [e.kind, e.handler])).toEqual([["main", "cli.ts#main"]]);
  });
});
