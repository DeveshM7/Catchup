import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildSnapshot, DEFAULT_GROUPING, type Facts } from "@catchup/analyzer";
import { loadSignals, saveAnalysis } from "@catchup/store";
import { headSha, loadWorkspace, withCode } from "./commits.js";

it("reads committed HEAD, not staged, unstaged or untracked working-tree changes", async () => {
  const repo = mkdtempSync(join(tmpdir(), "catchup-commit-"));
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  execFileSync("git", ["clone", "--quiet", "--shared", source, repo]);
  try {
    const original = readFileSync(join(repo, "AGENTS.md"), "utf8");
    writeFileSync(join(repo, "AGENTS.md"), "staged edit");
    execFileSync("git", ["-C", repo, "add", "AGENTS.md"]);
    writeFileSync(join(repo, "AGENTS.md"), "unstaged edit");
    writeFileSync(join(repo, "untracked.ts"), "export function uncommitted() {}");
    await withCode(repo, headSha(repo), async (dir) => {
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(original);
      expect(existsSync(join(dir, "untracked.ts"))).toBe(false);
    });
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("unstaged edit");
    expect(existsSync(join(repo, "untracked.ts"))).toBe(true);
    expect(execFileSync("git", ["-C", repo, "show", ":AGENTS.md"], { encoding: "utf8" })).toBe("staged edit");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

it("persists recovered signals so a resumed timelapse can load them", () => {
  const repo = mkdtempSync(join(tmpdir(), "catchup-signals-"));
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  execFileSync("git", ["clone", "--quiet", "--shared", source, repo]);
  try {
    const sha = headSha(repo);
    const facts: Facts = { sha, files: [], functions: [], imports: [], calls: [], entryPoints: [] };
    saveAnalysis(repo, facts, buildSnapshot(facts, [], DEFAULT_GROUPING));
    expect(loadSignals(repo, sha)).toBeUndefined();
    const ws = loadWorkspace(repo, repo, sha);
    expect(ws).toBeDefined();
    expect(loadSignals(repo, sha)).toEqual(ws?.signals);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
