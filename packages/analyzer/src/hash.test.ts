import { describe, expect, it } from "vitest";
import { extractFunctions } from "./functions.js";

const hashOf = (text: string): string => {
  const [fn] = extractFunctions("a.ts", text);
  if (!fn) throw new Error("no function found");
  return fn.hash;
};

describe("function body hash (D18)", () => {
  const base = "function f(a: number) {\n  return a + 1;\n}\n";

  it("ignores whitespace and formatting", () => {
    expect(hashOf("function f(a:number){return a+1}")).toBe(hashOf(base));
    expect(hashOf("function f( a: number ) {\n\n\n    return a + 1;\n}")).toBe(hashOf(base));
  });

  it("ignores comments", () => {
    expect(hashOf("/** docs */\nfunction f(a: number) {\n  // add one\n  return a + 1; /* trailing */\n}")).toBe(hashOf(base));
  });

  it("changes when the code changes", () => {
    expect(hashOf("function f(a: number) {\n  return a + 2;\n}")).not.toBe(hashOf(base));
    expect(hashOf("function f(a: number) {\n  return 'a + 1';\n}")).not.toBe(hashOf(base));
  });

  it.each([
    ["'a b'", "'a  b'"],
    ["`a b`", "`a\\nb`".replace("\\n", "\n")],
    ["`a ${value} b`", "`a  ${value} b`"],
    ["/a b/", "/a  b/"],
  ])("preserves meaningful literal whitespace: %s", (before, after) => {
    expect(hashOf(`function f() { return ${before}; }`)).not.toBe(hashOf(`function f() { return ${after}; }`));
  });
});
