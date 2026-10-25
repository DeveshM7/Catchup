import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Facts, Snapshot } from "@catchup/analyzer";
import { loadExplained, loadFacts, loadSnapshot, saveAnalysis, saveExplained } from "./index.js";

const facts: Facts = { sha: "abc", files: [], functions: [], imports: [], calls: [], entryPoints: [] };
const snapshot: Snapshot = {
  sha: "abc",
  components: [],
  edges: [],
  externals: [],
  summary: { files: 0, functions: 0, imports: 0, components: 0, externals: 0 },
};

describe("store", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes facts and snapshot under .catchup/ and reads them back", () => {
    dir = mkdtempSync(join(tmpdir(), "catchup-store-"));
    const paths = saveAnalysis(dir, facts, snapshot);
    expect(paths.facts).toBe(join(dir, ".catchup", "facts", "abc.json"));
    expect(paths.snapshot).toBe(join(dir, ".catchup", "snapshots", "abc.json"));
    expect(loadFacts(dir, "abc")).toEqual(facts);
    expect(loadSnapshot(dir, "abc")).toEqual(snapshot);
    expect(readFileSync(join(dir, ".catchup", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("saves explanations separately and returns undefined when missing", () => {
    dir = mkdtempSync(join(tmpdir(), "catchup-store-"));
    expect(loadExplained(dir, "abc")).toBeUndefined();
    saveExplained(dir, { sha: "abc", flows: [] });
    expect(loadExplained(dir, "abc")).toEqual({ sha: "abc", flows: [] });
  });
});
