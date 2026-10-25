import { describe, expect, it } from "vitest";
import { countLines, findPackageDirs, isSourcePath, languageOf } from "./files.js";

describe("isSourcePath", () => {
  it.each([
    ["src/index.ts", true],
    ["src/app/page.tsx", true],
    ["scripts/build.mjs", true],
    ["src/auth/login.test.ts", false],
    ["src/auth/login.spec.tsx", false],
    ["src/types.d.ts", false],
    ["vite.config.ts", false],
    ["src/test/helpers.ts", false],
    ["tests/e2e/fixtures.ts", false],
    ["node_modules/x/index.js", false],
    ["README.md", false],
  ])("%s → %s", (path, expected) => {
    expect(isSourcePath(path)).toBe(expected);
  });
});

describe("findPackageDirs", () => {
  it("returns nested package.json dirs, not the root or node_modules", () => {
    expect(
      findPackageDirs(["package.json", "packages/sdk/package.json", "node_modules/x/package.json", "packages/sdk/src/a.ts"]),
    ).toEqual(["packages/sdk"]);
  });
});

describe("countLines / languageOf", () => {
  it("counts lines with or without a trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });

  it("maps extensions to languages", () => {
    expect(languageOf("a.tsx")).toBe("typescript");
    expect(languageOf("a.mts")).toBe("typescript");
    expect(languageOf("a.jsx")).toBe("javascript");
  });
});
