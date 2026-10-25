import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, computeSignals } from "./index.js";

const REPO = fileURLToPath(new URL("../../../fixtures/tiny-web", import.meta.url));

describe("computeSignals on fixtures/tiny-web (known answers)", async () => {
  const { facts, snapshot } = await analyze(REPO, "test");
  const trees = buildCallTrees(facts, snapshot);
  const churn = new Map([["lib/db.ts", { commits: 3, lastChanged: "2026-01-02T00:00:00Z" }]]);
  const signals = computeSignals({ facts, trees, churn, readme: "Start in `components/chat.tsx`; handlePart shows titles." });

  it("ranks functions by flows, systems, callers and exports", () => {
    expect(signals.functions["lib/db.ts#saveChat"]).toEqual({ flows: 3, systems: ["Postgres"], fanIn: 1, exported: true, loc: 3, side: "server", readme: false });
    expect(signals.functions["components/parts.ts#handlePart"]).toMatchObject({ fanIn: 2, exported: true, side: "client", readme: true, systems: [] });
    expect(signals.functions["components/composer.tsx#Composer.submit"]).toMatchObject({ exported: false, flows: 2 });
  });

  it("ranks files by flows, importers, churn and README mentions", () => {
    expect(signals.files["lib/db.ts"]).toEqual({
      flows: 9,
      systems: ["Postgres"],
      fanIn: 3,
      churn: 3,
      lastChanged: "2026-01-02T00:00:00Z",
      readme: false,
      exported: true,
      loc: 23,
      side: "server",
    });
    expect(signals.files["components/chat.tsx"]).toMatchObject({ readme: true, churn: 0, fanIn: 1, side: "client" });
    // Sending from the composer and the chat route run the same code: one family.
    const chat = signals.families.find((f) => f.members.includes("http:POST /api/chat"));
    expect(chat?.members).toContain("ui:components/composer.tsx#Composer.submit");
  });
});
