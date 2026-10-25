import { describe, expect, it } from "vitest";
import { sourceForOutput } from "./packages.js";
import { appPageUrl, pagesPageUrl } from "./entrysources.js";
import { extractFunctions } from "./functions.js";

describe("sourceForOutput", () => {
  const files = new Set(["src/cli.ts", "src/index.ts", "bin/run.mjs", "packages/a/src/main.tsx", "lib/util/index.js"]);
  it("maps build output back to the source it came from", () => {
    expect(sourceForOutput("", "dist/cli.js", files)).toBe("src/cli.ts");
    expect(sourceForOutput("", "./dist/index.mjs", files)).toBe("src/index.ts");
    expect(sourceForOutput("", "bin/run.mjs", files)).toBe("bin/run.mjs");
    expect(sourceForOutput("packages/a", "dist/main.js", files)).toBe("packages/a/src/main.tsx");
    expect(sourceForOutput("", "lib/util", files)).toBe("lib/util/index.js");
  });
  it("skips type declarations, JSON and unknown paths", () => {
    expect(sourceForOutput("", "dist/index.d.ts", files)).toBeUndefined();
    expect(sourceForOutput("", "./package.json", files)).toBeUndefined();
    expect(sourceForOutput("", "dist/missing.js", files)).toBeUndefined();
  });
});

describe("page URLs", () => {
  it("reads Next.js app-router pages and layouts", () => {
    expect(appPageUrl("app/(chat)/chat/[id]/page.tsx")).toEqual({ url: "/chat/[id]", layout: false });
    expect(appPageUrl("app/(chat)/layout.tsx")).toEqual({ url: "/", layout: true });
    expect(appPageUrl("src/app/_private/page.tsx")).toBeUndefined();
    expect(appPageUrl("app/api/chat/route.ts")).toBeUndefined();
  });
  it("reads pages-router pages, not API routes or _app", () => {
    expect(pagesPageUrl("pages/index.tsx")).toBe("/");
    expect(pagesPageUrl("src/pages/settings/profile.tsx")).toBe("/settings/profile");
    expect(pagesPageUrl("pages/api/users.ts")).toBeUndefined();
    expect(pagesPageUrl("pages/_app.tsx")).toBeUndefined();
  });
});

describe("registration closures and module units", () => {
  const names = (text: string, moduleUnit = false): string[] => extractFunctions("a.ts", text, moduleUnit).map((f) => f.name);
  it("names closures registered under a string key", () => {
    const text = [
      'app.get("/users", (req, res) => res.send());',
      'emitter.on("ready", function () {});',
      'cli.command("build").option("--watch").action(async () => {});',
      "list.map((x) => x);",
      'retry("x", () => 1);',
    ].join("\n");
    expect(names(text)).toEqual(["command:build", "get:/users", "on:ready"]);
  });
  it("adds the top-level unit when asked, or when the file renders an app root", () => {
    expect(names("main();", true)).toEqual(["(module)"]);
    expect(names("main();")).toEqual([]);
    expect(extractFunctions("a.tsx", 'createRoot(el).render(<App />);').map((f) => f.name)).toEqual(["(module)"]);
  });
});
