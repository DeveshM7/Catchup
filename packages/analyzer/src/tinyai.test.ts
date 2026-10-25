import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, type TreeNode } from "./index.js";

const TINY_AI = fileURLToPath(new URL("../../../fixtures/tiny-ai", import.meta.url));
const grouping = { splitAbove: 80, mergeBelow: 1, maxComponents: 25 };

/** `name [flags]`, indented by depth; functions and externals only. */
function render(node: TreeNode, depth = 0): string[] {
  const flags = [node.site?.conditional ? "if" : "", node.site?.passed ? "passed" : "", node.site?.tool ? "tool" : ""].filter(Boolean);
  const label = node.kind === "function" ? node.fn : node.kind === "external" ? `ext:${node.system ?? node.package} ${node.callee}` : `${node.kind} ${node.callee}`;
  const line = `${"  ".repeat(depth)}${label}${flags.length ? ` [${flags.join(",")}]` : ""}`;
  return [line, ...(node.kind === "function" ? node.children.flatMap((c) => render(c, depth + 1)) : [])];
}

describe("analyze fixtures/tiny-ai (D33, known answers)", async () => {
  const { facts, snapshot } = await analyze(TINY_AI, "tiny-ai-sha", { grouping });

  it("names closures in a module-level factory's config object", () => {
    expect(facts.functions.map((f) => f.id)).toEqual([
      "src/app/api/chat/route.ts#POST",
      "src/artifacts/code.ts#codeHandler.onCreate",
      "src/artifacts/code.ts#stripFences",
      "src/artifacts/factory.ts#createHandler",
      "src/artifacts/text.ts#textHandler.onCreate",
      "src/tools/draft.ts#draft",
      "src/tools/weather.ts#forecast",
      "src/tools/weather.ts#weather.execute",
    ]);
  });

  it("follows tools into the handler picked from a list, and marks them as tools", () => {
    const [chat] = buildCallTrees(facts, snapshot);
    expect(chat?.partial).toBe(false);
    expect(chat?.systems).toEqual(["AI model (AI SDK)", "Postgres"]);
    expect(render(chat!.root)).toEqual([
      "src/app/api/chat/route.ts#POST",
      "  src/tools/draft.ts#draft [if,tool]",
      "    src/artifacts/code.ts#codeHandler.onCreate [if]",
      "      ext:AI model (AI SDK) streamText",
      "      src/artifacts/code.ts#stripFences",
      "    src/artifacts/factory.ts#createHandler [if]",
      "      callback config.onCreate [if]",
      "      ext:Postgres pool.query [if]",
      "    src/artifacts/text.ts#textHandler.onCreate [if]",
      "      ext:AI model (AI SDK) streamText",
      "    ext:AI model (AI SDK) tool",
      "  src/tools/weather.ts#weather.execute [if,passed,tool]",
      "    src/tools/weather.ts#forecast",
      "  ext:AI model (AI SDK) streamText",
      "  ext:AI model (AI SDK) result.toResponse",
    ]);
  });
});
