import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees } from "@catchup/analyzer";
import type { Runner } from "./droid.js";
import { explainOverview, mainFlows, overviewDirs, overviewLinks, overviewPrompt, readmeExcerpt, validateOverview, type OverviewInputs } from "./overview.js";
import type { OverviewOutput } from "./schemas.js";

const TINY_AI = fileURLToPath(new URL("../../../fixtures/tiny-ai", import.meta.url));
const grouping = { splitAbove: 80, mergeBelow: 1, maxComponents: 25 };
const readFile = (path: string): string | undefined => readFileSync(join(TINY_AI, path), "utf8");

const good: OverviewOutput = {
  summary: "A chat API where an AI model can write documents.",
  parts: [
    { id: "chat-api", name: "Chat API", description: "Takes a message and runs the model.", dirs: ["src/app/api/chat"] },
    { id: "ai-tools", name: "AI tools", description: "Tools the model can call.", dirs: ["src/tools"] },
    { id: "artifacts", name: "Artifacts", description: "Writes and saves documents.", dirs: ["src/artifacts"] },
  ],
  flows: [
    {
      entry: "http:POST /api/chat",
      title: "Sending a message",
      steps: [
        { text: "You send a prompt → the server calls the AI model.", functions: ["src/app/api/chat/route.ts#POST"] },
        { text: "The model may use a tool to write a document.", functions: ["src/tools/draft.ts#draft", "src/artifacts/text.ts#textHandler.onCreate"] },
        { text: "The document is saved.", functions: ["src/artifacts/factory.ts#createHandler"] },
      ],
    },
  ],
};

describe("overview on fixtures/tiny-ai (D34)", async () => {
  const { facts, snapshot } = await analyze(TINY_AI, "tiny-ai-sha", { grouping });
  const trees = buildCallTrees(facts, snapshot);
  const flows = mainFlows(trees);
  const inputs: OverviewInputs = {
    flows,
    brief: { functions: new Map(facts.functions.map((f) => [f.id, f])), readFile },
    packageLine: "tiny-ai",
    readme: readmeExcerpt(readFile("README.md")),
  };

  it("picks the main flow and the folders it runs through", () => {
    expect(flows.map((f) => f.tree.entryPoint.id)).toEqual(["http:POST /api/chat"]);
    expect(overviewDirs(flows)).toEqual(["src/app/api/chat", "src/artifacts", "src/tools"]);
    const prompt = overviewPrompt(inputs);
    expect(prompt).toContain("AI tools the model can call: [src/tools/draft.ts#draft], [src/tools/weather.ts#weather.execute]");
    expect(prompt).toContain("[AI tool]");
  });

  it("accepts a grounded answer and computes the diagram's links", () => {
    expect(validateOverview(good, flows)).toEqual([]);
    expect(overviewLinks(good.parts.map((p) => ({ ...p })), flows)).toEqual([
      { from: "ai-tools", to: "artifacts" },
      { from: "ai-tools", to: "system:AI model (AI SDK)" },
      { from: "artifacts", to: "system:AI model (AI SDK)" },
      { from: "artifacts", to: "system:Postgres" },
      { from: "chat-api", to: "ai-tools" },
      { from: "chat-api", to: "system:AI model (AI SDK)" },
    ]);
  });

  it("rejects invented functions, unplaced folders, missing tools and long text", () => {
    const bad: OverviewOutput = {
      summary: "word ".repeat(41),
      parts: [good.parts[0]!, { ...good.parts[1]!, dirs: ["src/tools", "src/nowhere"] }],
      flows: [
        {
          entry: "http:POST /api/chat",
          title: "Chat",
          steps: [
            { text: "Starts.", functions: ["src/app/api/chat/route.ts#POST", "src/made/up.ts#fn"] },
            { text: "Saves.", functions: ["src/artifacts/factory.ts#createHandler"] },
            { text: "Ends.", functions: ["src/app/api/chat/route.ts#POST"] },
          ],
        },
      ],
    };
    expect(validateOverview(bad, flows)).toEqual([
      "summary has 41 words (max 30)",
      'part "ai-tools" lists unknown folder "src/nowhere"',
      "folders in no part: src/artifacts",
      'flow http:POST /api/chat step 1 cites "src/made/up.ts#fn", which is not a function in this flow',
      "flow http:POST /api/chat: no step covers the AI tools (src/tools/draft.ts#draft, src/tools/weather.ts#weather.execute)",
    ]);
  });

  it("retries once, then copies the result forward without calling Claude", async () => {
    const answers = [{ ...good, parts: good.parts.slice(0, 2) }, good];
    let calls = 0;
    const runner: Runner = async () => ({ ok: true, value: answers[calls++] });
    const first = await explainOverview({ inputs, runner });
    expect(calls).toBe(2);
    expect(first.overview?.startHere).toBe("src/app/api/chat/route.ts");
    expect(first.overview?.systems).toEqual(["AI model (AI SDK)", "Postgres"]);
    expect(first.overview?.flows[0]).toMatchObject({ entry: "http:POST /api/chat", members: 1, title: "Sending a message" });

    const again = await explainOverview({ inputs, previous: first.overview, runner });
    expect(calls).toBe(2);
    expect(again).toEqual({ overview: first.overview, carried: true });
  });
});
