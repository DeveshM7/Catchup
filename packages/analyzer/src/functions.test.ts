import { describe, expect, it } from "vitest";
import { extractFunctions } from "./functions.js";

const names = (text: string, path = "a.ts"): string[] => extractFunctions(path, text).map((f) => f.name);

describe("extractFunctions", () => {
  it("names declarations, arrows, class members and object-literal methods", () => {
    const source = `
      export function a() {}
      const b = () => 1;
      const c = function named() {};
      class K { constructor() {} m() {} get g() { return 1; } field = () => 2; }
      const o = { p() {}, q: () => 3, inner: { r() {} } };
    `;
    expect(names(source)).toEqual(["K.constructor", "K.field", "K.g", "K.m", "a", "b", "c", "o.inner.r", "o.p", "o.q"]);
  });

  it("names anonymous default exports `default`", () => {
    expect(names("export default function () {}")).toEqual(["default"]);
    expect(names("export default () => 1;")).toEqual(["default"]);
    expect(names("export default { GET() {} };")).toEqual(["default.GET"]);
  });

  it("qualifies nested functions and skips anonymous callbacks", () => {
    const source = `
      function outer() {
        [1].map((x) => x);
        setTimeout(function () {}, 1);
        register({ onClick() {} });
        function helper() {}
      }
    `;
    expect(names(source)).toEqual(["outer", "outer.helper"]);
  });

  it("skips overload signatures and suffixes repeated names", () => {
    const source = `
      function f(x: string): void;
      function f(x: unknown) {}
      function g() { const h = () => 1; }
      function g2() { if (1) { const h = () => 1; } }
      const dup = { x() {} };
      function x() {}
    `;
    expect(names(source)).toEqual(["dup.x", "f", "g", "g.h", "g2", "g2.h", "x"]);
    const twice = "function t() { const h = () => 1; { const h = () => 2; } }";
    expect(names(twice)).toEqual(["t", "t.h", "t.h~2"]);
  });

  it("records ids and 1-based line ranges", () => {
    const [fn] = extractFunctions("src/x.ts", "\nexport function a() {\n  return 1;\n}\n");
    expect(fn).toMatchObject({ id: "src/x.ts#a", file: "src/x.ts", startLine: 2, endLine: 4 });
  });

  it("parses JSX", () => {
    expect(names("export const Page = () => <div>hi</div>;", "p.tsx")).toEqual(["Page"]);
  });
});

describe("errors caught and not re-thrown (D61)", () => {
  it("marks functions whose own catch never throws, not ones that rethrow or whose catch is in a nested function", () => {
    const fns = extractFunctions(
      "x.ts",
      [
        "export async function hides() { try { await a(); } catch (e) { console.log(e); } }",
        "export async function rethrows() { try { await a(); } catch (e) { log(e); throw e; } }",
        "export function outer() { const inner = () => { try { a(); } catch {} }; return inner; }",
        "export function plain() { return 1; }",
      ].join("\n"),
    );
    expect(Object.fromEntries(fns.map((f) => [f.name, f.swallows === true]))).toEqual({ hides: true, rethrows: false, outer: false, "outer.inner": true, plain: false });
  });
});
