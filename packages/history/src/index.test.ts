import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commitsBetween, fileChurn, packageName, parseChurn, pickCheckpoints, resolveCommit, withWorktree } from "./index.js";

const AI_CHATBOT = fileURLToPath(new URL("../../../fixtures/ai-chatbot", import.meta.url));

describe("history", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("history");
  });

  it("counts commits per file, newest date first", () => {
    const log = ["\u00012026-03-02T10:00:00+00:00", "", "src/a.ts", "src/b.ts", "\u00012026-01-05T09:00:00+00:00", "", "src/a.ts", ""].join("\n");
    expect(Object.fromEntries(parseChurn(log))).toEqual({
      "src/a.ts": { commits: 2, lastChanged: "2026-03-02T10:00:00+00:00" },
      "src/b.ts": { commits: 1, lastChanged: "2026-03-02T10:00:00+00:00" },
    });
  });

  it.skipIf(!existsSync(AI_CHATBOT))("reads churn from a real repo", () => {
    const churn = fileChurn(AI_CHATBOT);
    const route = churn.get("app/(chat)/api/chat/route.ts");
    expect(route?.commits).toBeGreaterThan(5);
    expect(route?.lastChanged).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fills the checkpoint budget when many commits share a timestamp", () => {
    const commits = Array.from({ length: 20 }, (_, i) => ({ sha: String(i), date: "2026-01-01T00:00:00Z", subject: `commit ${i}`, tags: [] }));
    const picked = pickCheckpoints(commits, 15);
    expect(picked).toHaveLength(15);
    expect(picked[0]).toBe(commits[0]);
    expect(picked.at(-1)).toBe(commits.at(-1));
    expect(new Set(picked).size).toBe(15);
  });

  it.skipIf(!existsSync(AI_CHATBOT))("keeps a merge endpoint in timelapse ranges and available citations", () => {
    const merge = execFileSync("git", ["-C", AI_CHATBOT, "log", "--merges", "-1", "--format=%H"], { encoding: "utf8" }).trim();
    expect(merge).not.toBe("");
    const commits = commitsBetween(AI_CHATBOT, `${merge}^1`, merge);
    expect(commits.at(-1)?.sha).toBe(merge);
  });

  it("clears a leftover checkout folder that git no longer lists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "catchup-worktree-"));
    const source = fileURLToPath(new URL("../../../", import.meta.url));
    execFileSync("git", ["clone", "--quiet", "--shared", source, repo]);
    try {
      const sha = resolveCommit(repo, "HEAD");
      mkdirSync(join(repo, ".catchup", "worktrees", sha.slice(0, 12)), { recursive: true });
      expect(await withWorktree(repo, sha, async (dir) => readFileSync(join(dir, "AGENTS.md"), "utf8").length > 0)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("never removes a checkout another caller is still using", async () => {
    const repo = mkdtempSync(join(tmpdir(), "catchup-worktree-"));
    const source = fileURLToPath(new URL("../../../", import.meta.url));
    execFileSync("git", ["clone", "--quiet", "--shared", source, repo]);
    try {
      const sha = resolveCommit(repo, "HEAD");
      await withWorktree(repo, sha, async (dir) => {
        const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
        await expect(withWorktree(repo, sha, async () => undefined)).rejects.toThrow();
        expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
      });
      expect(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).match(/^worktree /gm)).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
