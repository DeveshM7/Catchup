import { describe, expect, it } from "vitest";
import { commonDir, partId, stepId } from "./tree.js";
import { assignFiles, checkSteps, checkWords, type StepRules } from "./treecheck.js";

const files = ["app/api/chat/route.ts", "app/api/history/route.ts", "app/page.tsx", "lib/db.ts", "lib/ai/tools/a.ts", "lib/ai/tools/b.ts"];

describe("assignFiles", () => {
  it("gives each file to the most specific path", () => {
    const { files: out, problems } = assignFiles(
      [
        { title: "API", paths: ["app/api"] },
        { title: "Screens", paths: ["app"] },
        { title: "Lib", paths: ["lib/"] },
        { title: "Tools", paths: ["./lib/ai/tools"] },
      ],
      files,
    );
    expect(problems).toEqual([]);
    expect(out).toEqual([["app/api/chat/route.ts", "app/api/history/route.ts"], ["app/page.tsx"], ["lib/db.ts"], ["lib/ai/tools/a.ts", "lib/ai/tools/b.ts"]]);
  });

  it("reports missing files, shared paths and empty children, and ignores paths that match no file", () => {
    const { problems } = assignFiles(
      [
        { title: "A", paths: ["app", "nope"] },
        { title: "B", paths: ["app"] },
        { title: "C", paths: ["app/page.tsx"] },
        { title: "D", paths: ["lib/ai/tools/a.ts"] },
        { title: "E", paths: ["lib/ai/tools/a.ts"] },
      ],
      files,
    );
    expect(problems).toContain(`path "app" is given to both "A" and "B"`);
    expect(problems.some((p) => p.includes("nope"))).toBe(false);
    expect(problems.some((p) => p.startsWith("2 file(s) belong to no part: lib/db.ts, lib/ai/tools/b.ts"))).toBe(true);
    expect(problems).toContain(`"B" gets no files (its paths match none of the files, or more specific paths took them all)`);
  });
});

describe("ids", () => {
  it("names parts by their folder, else their most central file", () => {
    const taken = new Set<string>();
    const central = (fs: string[]): string => fs[fs.length - 1]!;
    expect(commonDir(["app/api/chat/route.ts", "app/api/history/route.ts"])).toBe("app/api");
    expect(partId(["app/api/chat/route.ts", "app/api/history/route.ts"], taken, central)).toBe("part:app/api");
    expect(partId(["app/api/x.ts", "app/api/y.ts"], taken, central)).toBe("part:app/api/y.ts");
    expect(partId(["app/page.tsx", "lib/db.ts"], taken, central)).toBe("part:lib/db.ts");
    expect(partId(["lib/db.ts"], taken, central)).toBe("part:lib/db.ts~2");
  });

  it("hashes step ids from the cited functions, whatever their order", () => {
    const a = stepId("journey:x", ["f#a", "f#b"], new Set());
    expect(a).toMatch(/^journey:x#[0-9a-f]{8}$/);
    expect(stepId("journey:x", ["f#b", "f#a"], new Set())).toBe(a);
    expect(stepId("journey:x", ["f#a", "f#b"], new Set([a]))).toBe(`${a}~2`);
  });
});

describe("checkWords", () => {
  it("allows slack over the asked length", () => {
    expect(checkWords("x", { short: "one two three four five six seven eight nine ten eleven twelve thirteen" })).toEqual([]);
    expect(checkWords("x", { short: Array(16).fill("w").join(" ") })).toEqual(["x: short has 16 words (at most 12)"]);
  });
});

describe("checkSteps", () => {
  const rules: StepRules = {
    allowed: new Set(["h", "a", "b", "c", "t1", "t2"]),
    order: new Map(["h", "a", "b", "c", "t1", "t2"].map((fn, i) => [fn, i])),
    first: "h",
    mustCover: [["h"], ["t1", "t2"], ["c"]],
    min: 3,
    max: 7,
  };
  const step = (title: string, functions: string[], kind: "main" | "check" = "main") => ({ title, short: "s", long: "l", kind, functions, open: false });

  it("accepts steps in call order that cover the key functions", () => {
    expect(checkSteps({ steps: [step("Start", ["h", "a"]), step("Checks", ["b"], "check"), step("Tool", ["t2", "c"])] }, rules)).toEqual([]);
  });

  it("rejects unknown functions, a missing handler, wrong order and uncovered key functions", () => {
    const problems = checkSteps({ steps: [step("One", ["a", "x"]), step("Two", ["c"]), step("Three", ["b"])] }, rules);
    expect(problems).toContain(`step 1 ("One") cites "x", which is not a function in this journey's call tree`);
    expect(problems).toContain("the first step must include the entry handler h");
    expect(problems).toContain(`step 3 ("Three") starts with code that runs before "Two"; order the main steps as the code runs`);
    expect(problems).toContain("these key functions are in no step: h, t1 or t2");
  });
});
