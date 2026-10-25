import { describe, expect, it } from "vitest";
import { validateAreas, validateFlow, validateLabels } from "./validate.js";

const check = {
  allowed: new Set(["a#root", "a#one", "a#two", "a#three", "a#four"]),
  mustCover: ["a#root", "a#two"],
  previousIds: new Set(["old-1", "old-2"]),
  keepIds: new Set(["old-1"]),
};
const step = (functions: string[], id: string | null = null) => ({ id, label: "Do it", summary: "Does it.", functions, kind: "main" as const });

describe("validateFlow", () => {
  it("accepts a valid flow", () => {
    const steps = [step(["a#root"], "old-1"), step(["a#one"]), step(["a#two"]), step(["a#three", "a#four"])];
    expect(validateFlow({ steps }, check)).toEqual([]);
  });

  it("reports unknown functions, missing coverage, step counts, bad and dropped ids", () => {
    const errors = validateFlow({ steps: [step(["a#root", "a#ghost"], "nope"), step([])] }, check);
    expect(errors).toEqual([
      "expected 4–8 steps, got 2",
      'step 1 ("Do it") cites "a#ghost", which is not a function in this flow',
      'step 1 ("Do it") has id "nope", which is not a previous step id (use null for new steps)',
      'step 2 ("Do it") lists no functions',
      "these important functions are in no step: a#two",
      'unchanged step "old-1" must be kept (return it with its id)',
    ]);
  });

  it("allows fewer steps for tiny flows", () => {
    const tiny = { allowed: new Set(["a#root"]), mustCover: ["a#root"], previousIds: new Set<string>(), keepIds: new Set<string>() };
    expect(validateFlow({ steps: [step(["a#root"])] }, tiny)).toEqual([]);
  });
});

describe("validateLabels / validateAreas", () => {
  it("requires exactly the expected component ids", () => {
    const labels = [{ id: "src/a", name: "A", description: "a" }, { id: "src/x", name: "X", description: "x" }];
    expect(validateLabels({ labels }, ["src/a", "src/b"])).toEqual(['unknown component "src/x"', "missing labels for: src/b"]);
  });

  it("puts every flow in exactly one area", () => {
    const areas = [
      { id: "auth", name: "Auth", description: "d", flows: ["f1", "f2"] },
      { id: "data", name: "Data", description: "d", flows: ["f2", "f9"] },
    ];
    expect(validateAreas({ areas }, ["f1", "f2", "f3"])).toEqual([
      "expected 3–7 areas, got 2",
      'flow "f2" is in both "auth" and "data"',
      'area "data" lists unknown flow "f9"',
      "flows in no area: f3",
    ]);
  });
});
