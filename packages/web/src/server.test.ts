import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { sourceOf, startDashboard } from "./server/server.js";
import type { DashboardInputs } from "./server/data.js";

const empty = (repoRoot: string, sha = "test"): DashboardInputs => ({
  repoRoot,
  facts: { sha, files: [], functions: [], imports: [], calls: [], entryPoints: [] },
  snapshot: { sha, components: [], edges: [], externals: [], summary: { files: 0, functions: 0, imports: 0, components: 0, externals: 0 } },
  trees: [],
  signals: { sha, functions: {}, files: {}, families: [] },
});

describe("dashboard source contexts", () => {
  it("reads HEAD source from its commit and preview source from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "catchup-source-"));
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    try {
      execFileSync("git", ["clone", "--shared", "--no-checkout", root, dir], { stdio: "pipe" });
      const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const inputs = empty(dir, sha);
      inputs.facts.functions.push({ id: "README.md#intro", name: "intro", file: "README.md", startLine: 1, endLine: 1, hash: "x" });
      writeFileSync(join(dir, "README.md"), "working tree text\n");
      expect(sourceOf(inputs, "README.md#intro")?.text).toBe("# Catchup");
      expect(sourceOf(inputs, "README.md#intro", true)?.text).toBe("working tree text");
      expect(sourceOf(inputs, "missing")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("local API boundary", () => {
  it("rejects cross-origin POSTs before running an Open or Ask pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catchup-http-"));
    const inputs = empty(dir);
    const ask = vi.fn();
    const open = vi.fn();
    const dashboard = await startDashboard({ ...inputs, ask, open }, { port: 0 });
    try {
      for (const path of ["ask", "open?id=part:lib"]) {
        const res = await fetch(`${dashboard.url}api/${path}`, { method: "POST", headers: { Origin: "https://unrelated.example" }, body: "{}" });
        expect(res.status).toBe(403);
      }
      expect(ask).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      const sameOrigin = await fetch(`${dashboard.url}api/ask`, { method: "POST", headers: { Origin: new URL(dashboard.url).origin }, body: '{"question":"Why?"}' });
      expect(sameOrigin.status).toBe(200);
      expect(await sameOrigin.text()).toContain("no understanding yet");
    } finally {
      await dashboard.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
