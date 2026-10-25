import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { analyze, buildCallTrees, type CallTree, type Facts, type TreeNode } from "./index.js";

const REPO = fileURLToPath(new URL("../../../fixtures/tiny-web", import.meta.url));

/** `fn [flags]` per function node, indented by depth. */
function outline(node: TreeNode, depth = 0): string[] {
  if (node.kind !== "function") return [];
  const site = node.site;
  const flags = [
    site?.render ? "render" : "",
    site?.remote ? `remote ${site.remote}` : "",
    site?.message ? `message ${site.message}` : "",
    node.stop ?? "",
  ].filter(Boolean);
  const line = `${"  ".repeat(depth)}${node.fn}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
  return [line, ...node.children.flatMap((c) => outline(c, depth + 1))];
}

describe("analyze fixtures/tiny-web (known answers, Build 1 client and server)", () => {
  let facts: Facts;
  let trees: CallTree[];
  beforeAll(async () => {
    const result = await analyze(REPO, "test");
    facts = result.facts;
    trees = buildCallTrees(result.facts, result.snapshot);
  });
  const tree = (label: string): CallTree => {
    const found = trees.find((t) => t.entryPoint.label === label);
    if (!found) throw new Error(`no tree ${label}`);
    return found;
  };

  it("finds routes, the page, the action and the UI events that reach the server", () => {
    expect(facts.entryPoints.map((e) => e.label)).toEqual([
      "action rename",
      "DELETE /api/chat",
      "DELETE /api/history",
      "GET /api/history",
      "POST /api/chat",
      "page /",
      "Chat onClick (Chat.onClick:button)",
      "Chat onClick (Chat.onClick:button~2)",
      "Composer onSubmit",
    ]);
  });

  it("knows where each file runs", () => {
    expect(Object.fromEntries(facts.files.map((f) => [f.path, f.side]))).toEqual({
      "app/actions.ts": "server",
      "app/api/chat/route.ts": "server",
      "app/api/history/route.ts": "server",
      "app/page.tsx": "server",
      "components/chat.tsx": "client",
      "components/composer.tsx": "client",
      "components/parts.ts": "client",
      // Imported only through a server action: the client calls it, the server runs it.
      "lib/db.ts": "server",
      "lib/fetcher.ts": "client",
    });
  });

  it("links written URLs, configured packages and server actions to the server", () => {
    const remote = facts.calls.filter((c) => c.remote).map((c) => [c.from, c.remote, c.oneOf ?? false]);
    expect(remote).toEqual([
      // The URL handed to useChat's transport: no method written, so either route at that path.
      ["components/chat.tsx#Chat", "http:DELETE /api/chat", true],
      ["components/chat.tsx#Chat", "http:POST /api/chat", true],
      // `useSWR("/api/history")`: no method written, so either route at that path.
      ["components/chat.tsx#Chat", "http:DELETE /api/history", true],
      ["components/chat.tsx#Chat", "http:GET /api/history", true],
      ["components/chat.tsx#Chat.onClick:button", "http:DELETE /api/history", false],
      ["components/chat.tsx#Chat.onClick:button~2", "action:app/actions.ts#rename", false],
      // `send` is typed as useChat's sendMessage, and useChat was given /api/chat: a send function posts.
      ["components/composer.tsx#Composer.submit", "http:POST /api/chat", false],
    ]);
  });

  it("renders the page, stops at UI events, and follows messages back to the browser", () => {
    expect(outline(tree("page /").root)).toEqual([
      "app/page.tsx#Page",
      "  components/chat.tsx#Chat [render]",
      "    app/api/chat/route.ts#DELETE [remote http:DELETE /api/chat]",
      "      lib/db.ts#deleteChat",
      "    app/api/chat/route.ts#POST [remote http:POST /api/chat]",
      "      lib/db.ts#saveChat",
      "      components/parts.ts#handlePart [message data-title, message]",
      "    components/parts.ts#handlePart",
      "    app/api/history/route.ts#DELETE [remote http:DELETE /api/history]",
      "      lib/db.ts#clearChats",
      "    app/api/history/route.ts#GET [remote http:GET /api/history]",
      "      lib/db.ts#listChats",
      "    lib/fetcher.ts#fetcher",
      "    components/composer.tsx#Composer [render]",
      "      components/composer.tsx#Composer.submit [event]",
      "    components/chat.tsx#Chat.onClick:button [event]",
      "    components/chat.tsx#Chat.onClick:button~2 [event]",
    ]);
    expect(outline(tree("Composer onSubmit").root)).toEqual([
      "components/composer.tsx#Composer.submit",
      "  app/api/chat/route.ts#POST [remote http:POST /api/chat]",
      "    lib/db.ts#saveChat",
      "    components/parts.ts#handlePart [message data-title, message]",
    ]);
    expect(tree("Composer onSubmit").systems).toEqual(["AI model (AI SDK)", "Postgres"]);
  });
});
