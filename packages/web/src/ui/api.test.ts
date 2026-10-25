import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskEvent } from "../shared/types";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("Ask streaming", () => {
  it("handles a terminal answer without a trailing newline", async () => {
    const answer: AskEvent = { type: "answer", reply: { answer: "Done", nodes: [], files: [], functions: [], commits: [], steps: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(answer))));
    const events: AskEvent[] = [];
    await api.ask({ question: "What happens?" }, (e) => events.push(e));
    expect(events).toEqual([answer]);
  });

  it("reports a truncated stream rather than leaving Ask busy forever", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"type":"step","step":{"name":"Read","target":"a.ts"}}\n')));
    await expect(api.ask({ question: "Why?" }, () => undefined)).rejects.toThrow("ended early");
  });

  it("does not turn a server error event into a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"type":"error","error":"Unavailable"}\n')));
    const events: AskEvent[] = [];
    await api.ask({ question: "Why?" }, (e) => events.push(e));
    expect(events).toEqual([{ type: "error", error: "Unavailable" }]);
  });
});

describe("source contexts", () => {
  it("keeps HEAD cached but reads each preview version from the server", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    // Each fetch needs an unread response body.
    fetch.mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetch);
    await api.source("example.ts#run");
    await api.source("example.ts#run");
    await api.source("example.ts#run", true);
    await api.source("example.ts#run", true);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "/api/source?fn=example.ts%23run",
      "/api/source?fn=example.ts%23run&preview=1",
      "/api/source?fn=example.ts%23run&preview=1",
    ]);
  });
});
