import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, computeSignals } from "@catchup/analyzer";
import { buildDigest, understand, type Runner } from "@catchup/agent";
import { Preview } from "./server/preview.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/tiny-changes", import.meta.url));
const answers = JSON.parse(readFileSync(join(FIXTURE, "answers.json"), "utf8")) as { v1: Record<string, unknown> };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("live preview on uncommitted changes (Build 7)", () => {
  it("re-analyzes after a save and shows the right changes within 5 s, with no Claude call", { timeout: 60_000 }, async () => {
    const repo = mkdtempSync(join(tmpdir(), "catchup-preview-"));
    const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    cpSync(join(FIXTURE, "v1"), repo, { recursive: true });
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "v1");

    const { facts, snapshot } = await analyze(repo, git("rev-parse", "HEAD").trim());
    const trees = buildCallTrees(facts, snapshot);
    const signals = computeSignals({ facts, trees });
    const readFile = (p: string): string | undefined => readFileSync(join(repo, p), "utf8");
    const digest = buildDigest({ facts, snapshot, signals, trees, readFile });
    const runnerFor = (pass: string): Runner => async () => ({ ok: true, value: answers.v1[pass] });
    const { understanding } = await understand({ facts, snapshot, signals, trees, digest: digest.files, digestDir: "/d", maxToolCalls: 0, readFile, model: "m", runnerFor });

    const preview = new Preview({ repoRoot: repo, head: { understanding, facts } }, 300);
    preview.start();
    try {
      await preview.ready();
      for (let i = 0; i < 100 && preview.current().runs < 1; i++) await sleep(100);
      expect(preview.current().result?.changes.nodes).toEqual({ added: [], removed: [], changed: [] });

      // The planted changes, saved but not committed.
      for (const entry of readdirSync(repo)) if (entry !== ".git" && entry !== ".catchup") rmSync(join(repo, entry), { recursive: true, force: true });
      cpSync(join(FIXTURE, "v2"), repo, { recursive: true });
      const saved = Date.now();
      for (let i = 0; i < 100 && !preview.current().result?.changes.systems.added.length; i++) await sleep(100);
      const elapsed = Date.now() - saved;

      const changes = preview.current().result!.changes;
      expect(elapsed).toBeLessThan(5_000);
      expect(changes.to).toBe("working");
      expect(changes.files.added).toEqual(["app/api/export/route.ts", "lib/export.ts", "lib/http.ts"]);
      expect(changes.files.removed).toEqual(["lib/fetcher.ts"]);
      expect(changes.entryPoints.added).toEqual(["GET /api/export"]);
      expect(changes.systems.added).toEqual(["Redis"]);
      expect(changes.journeys[0]).toMatchObject({ systemsAdded: ["Redis"], checksRemoved: ["Check the user"], functionsRemoved: ["lib/auth.ts#requireUser"] });
      expect(preview.current().error).toBeNull();
    } finally {
      await preview.stop();
    }
  });
});
