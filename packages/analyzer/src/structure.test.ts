import { describe, expect, it } from "vitest";
import { groupFiles, type GroupingOptions } from "./structure.js";

const files = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}/f${i}.ts`);
const components = (paths: string[], packages: string[], options: GroupingOptions): Record<string, number> => {
  const { componentOf } = groupFiles(paths, packages, options);
  const counts: Record<string, number> = {};
  for (const id of componentOf.values()) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
};

const opts: GroupingOptions = { splitAbove: 10, mergeBelow: 3, maxComponents: 25 };

describe("groupFiles (D19)", () => {
  it("uses depth-1 folders under src/ and top-level folders elsewhere", () => {
    const paths = [...files("src/api", 4), ...files("src/db", 3), ...files("scripts", 3), "src/index.ts", "server.ts"];
    expect(components(paths, [], opts)).toEqual({ "src/api": 4, "src/db": 3, scripts: 3, src: 1, ".": 1 });
  });

  it("splits big folders into depth-2 folders, keeping direct files in the parent", () => {
    const paths = [...files("src/app/api", 6), ...files("src/app/pages", 5), "src/app/layout.ts"];
    expect(components(paths, [], opts)).toEqual({ "src/app/api": 6, "src/app/pages": 5, "src/app": 1 });
  });

  it("merges tiny depth-2 folders into their parent and tiny depth-1 folders into the base", () => {
    const paths = [...files("src/app/api", 9), ...files("src/app/sso", 2), ...files("src/tiny", 2), ...files("lib", 3)];
    expect(components(paths, [], opts)).toEqual({ "src/app/api": 9, "src/app": 2, src: 2, lib: 3 });
  });

  it("treats each workspace package as one component, never merged", () => {
    const paths = [...files("packages/sdk/src/deep/er", 1), ...files("src/api", 3)];
    const { componentOf, kinds } = groupFiles(paths, ["packages/sdk"], opts);
    expect(componentOf.get("packages/sdk/src/deep/er/f0.ts")).toBe("packages/sdk");
    expect(kinds.get("packages/sdk")).toBe("package");
  });

  it("merges the smallest folders until the cap holds", () => {
    const paths = [...files("src/a", 5), ...files("src/b", 4), ...files("src/c", 3), ...files("src/d", 6)];
    expect(components(paths, [], { ...opts, maxComponents: 3 })).toEqual({ "src/a": 5, "src/d": 6, src: 7 });
  });

  it("is independent of input order", () => {
    const paths = [...files("src/a", 5), ...files("src/b", 1), ...files("x", 4)];
    const forward = groupFiles(paths, [], opts).componentOf;
    const backward = groupFiles([...paths].reverse(), [], opts).componentOf;
    expect([...backward].sort()).toEqual([...forward].sort());
  });
});
