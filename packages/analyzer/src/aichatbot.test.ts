import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildCallTrees, flowFamilies, type CallSite, type TreeNode } from "./index.js";

const REPO = fileURLToPath(new URL("../../../fixtures/ai-chatbot", import.meta.url));

describe.skipIf(!existsSync(REPO))("analyze fixtures/ai-chatbot (smoke)", () => {
  it("finds every route and the systems it touches", { timeout: 120_000 }, async () => {
    const { facts, snapshot } = await analyze(REPO, "smoke");
    expect(snapshot.externals.map((e) => e.name)).toEqual(
      expect.arrayContaining(["AI model (AI SDK)", "Blob storage (Vercel)", "Postgres", "Redis"]),
    );
    const trees = buildCallTrees(facts, snapshot);
    expect(trees.filter((t) => t.entryPoint.kind === "http").length).toBe(15);
    const labels = facts.entryPoints.map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining(["page /", "page /chat/[id]", "layout /", "action generateTitleFromUserMessage"]));
    for (const t of trees) expect(t.partial).toBe(false);
    const chat = trees.find((t) => t.entryPoint.label === "POST /api/chat");
    expect(chat?.systems).toEqual(expect.arrayContaining(["AI model (AI SDK)", "Postgres", "Redis"]));
    const upload = trees.find((t) => t.entryPoint.label === "POST /api/files/upload");
    expect(upload?.systems).toContain("Blob storage (Vercel)");
    // D32: the chat flow is the main flow, well ahead of the rest; sending from the UI belongs to it.
    const [main, second] = flowFamilies(trees);
    expect(main?.members).toEqual(expect.arrayContaining(["http:POST /api/chat", "ui:components/chat/multimodal-input.tsx#PureMultimodalInput.handlePromptSubmit"]));
    expect(main!.score).toBeGreaterThan(2 * second!.score);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("follows sending a message from the UI through the server and back to the browser (D42)", { timeout: 120_000 }, async () => {
    const { facts, snapshot } = await analyze(REPO, "smoke");
    const send = buildCallTrees(facts, snapshot).find((t) => t.entryPoint.label === "PureMultimodalInput onSubmit");
    const reached = new Map<string, CallSite | undefined>();
    const walk = (node: TreeNode): void => {
      if (node.kind !== "function") return;
      if (!reached.has(node.fn)) reached.set(node.fn, node.site);
      node.children.forEach(walk);
    };
    if (!send) throw new Error("no send-message entry point");
    walk(send.root);
    expect(reached.get("app/(chat)/api/chat/route.ts#POST")?.remote).toBe("http:POST /api/chat");
    for (const fn of ["lib/ai/tools/create-document.ts#createDocument", "artifacts/text/server.ts#textDocumentHandler.onCreateDocument", "lib/db/queries.ts#saveDocument"]) {
      expect(reached.has(fn)).toBe(true);
    }
    expect(reached.get("components/chat/data-stream-handler.tsx#DataStreamHandler")?.message).toBeDefined();
    expect(reached.get("artifacts/text/client.tsx#textArtifact.onStreamPart")?.message).toBe("data-textDelta");
    expect(facts.files.find((f) => f.path === "components/chat/data-stream-handler.tsx")?.side).toBe("client");
    expect(facts.files.find((f) => f.path === "lib/db/queries.ts")?.side).toBe("server");
  });
});
