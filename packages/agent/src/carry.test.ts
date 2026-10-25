import { describe, expect, it } from "vitest";
import { mergeSteps, planFlow } from "./carry.js";
import type { Flow } from "./schemas.js";

const previous: Flow = {
  id: "http:GET /x",
  label: "GET /x",
  partial: false,
  basis: { "a#root": "h1", "a#auth": "h2", "a#db": "h3" },
  steps: [
    { id: "s-auth", label: "Check auth", summary: "Checks.", functions: ["a#root", "a#auth"], kind: "main" },
    { id: "s-db", label: "Load data", summary: "Loads.", functions: ["a#db"], kind: "main" },
  ],
};

describe("planFlow", () => {
  it("carries a flow whose functions are unchanged", () => {
    expect(planFlow(previous, { ...previous.basis })).toEqual({ mode: "carry", flow: previous });
    expect(planFlow(undefined, {})).toEqual({ mode: "new" });
  });

  it("keeps steps that cite no changed or removed function", () => {
    const plan = planFlow(previous, { "a#root": "h1", "a#auth": "h2", "a#db": "CHANGED", "a#cache": "h4" });
    expect(plan).toMatchObject({ mode: "update", changed: ["a#db"], added: ["a#cache"], removed: [] });
    expect(plan.mode === "update" && [...plan.keepIds]).toEqual(["s-auth"]);
  });
});

describe("mergeSteps", () => {
  it("copies kept steps verbatim, keeps revised ids, and gives new steps stable ids", () => {
    const output = {
      steps: [
        { id: "s-auth", label: "Claude reworded this", summary: "x", functions: ["a#root"], kind: "main" as const },
        { id: "s-db", label: "Load data from cache", summary: "Loads, cached.", functions: ["a#db", "a#cache"], kind: "main" as const },
        { id: null, label: "Report errors", summary: "Fails.", functions: ["a#err"], kind: "error" as const },
      ],
    };
    const steps = mergeSteps(previous.id, output, previous, new Set(["s-auth"]));
    expect(steps[0]).toBe(previous.steps[0]);
    expect(steps[1]).toEqual({ id: "s-db", label: "Load data from cache", summary: "Loads, cached.", functions: ["a#db", "a#cache"], kind: "main" });
    expect(steps[2]?.id).toMatch(/^http:GET \/x#[0-9a-f]{8}$/);
    expect(mergeSteps(previous.id, output, previous, new Set(["s-auth"]))[2]?.id).toBe(steps[2]?.id);
  });
});
