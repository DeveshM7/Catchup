import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileChurn, packageName, parseChurn } from "./index.js";

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
});
