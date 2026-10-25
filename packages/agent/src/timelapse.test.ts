import { describe, expect, it } from "vitest";
import type { ChangeSet } from "./changes.js";
import type { Runner } from "./droid.js";
import { captionPrompt, captionStep, checkCaption } from "./timelapse.js";

const changes: ChangeSet = {
  from: "aaaaaaa1",
  to: "bbbbbbb2",
  files: { added: ["lib/artifacts/server.ts"], removed: [], renamed: [], changed: [] },
  entryPoints: { added: ["POST /api/document"], removed: [] },
  systems: { added: ["Blob storage (Vercel)"], removed: [] },
  nodes: { added: [], removed: [], changed: [] },
  journeys: [],
};
const commits = [
  { sha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", date: "2024-01-02T00:00:00Z", subject: "Add artifacts" },
  { sha: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", date: "2024-02-03T00:00:00Z", subject: "Upload files to Blob" },
];

describe("timelapse captions (Build 9)", () => {
  it("briefs Claude with the change set and the step's commits", () => {
    const prompt = captionPrompt({ summary: "A chat app.", changes, commits });
    expect(prompt).toContain("Entry points added: POST /api/document");
    expect(prompt).toContain("- 2222222 2024-02-03 Upload files to Blob");
  });

  it("requires cited commits from the step and word caps", () => {
    expect(checkCaption({ caption: "Artifacts arrive.", impact: "Docs in a panel.", commits: ["1111111"] }, commits)).toEqual([]);
    expect(checkCaption({ caption: "x", impact: "y", commits: [] }, commits)).toEqual(["expected 1–4 commits, got 0"]);
    expect(checkCaption({ caption: "x", impact: "y", commits: ["3333333"] }, commits)).toEqual([`commit "3333333" is not one of this step's commits`]);
    expect(checkCaption({ caption: "x", impact: "y", commits: [] }, [])).toEqual([]);
  });

  it("retries once and returns full shas", async () => {
    let n = 0;
    const runner: Runner = async () => ({ ok: true, value: n++ === 0 ? { caption: "a", impact: "b", commits: ["9999999"] } : { caption: "Artifacts arrive.", impact: "Docs in a panel.", commits: ["2222222", "1111111"] } });
    expect(await captionStep({ summary: "s", changes, commits, runner })).toEqual({ caption: "Artifacts arrive.", impact: "Docs in a panel.", commits: [commits[1]!.sha, commits[0]!.sha] });
  });
});
