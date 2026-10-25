import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { agentRunner, type PassLog } from "./agent.js";
import { anthropicRunner, anthropicSession, apiSchema, providerFrom, runReadTool, type CreateMessage } from "./anthropic.js";

/** A tiny repo with a file to read, a dependency folder and a secret that the tools must never show. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "catchup-anthropic-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "src/chat.ts"), "export function send() {\n  return fetch('/api/chat');\n}\n");
  writeFileSync(join(root, "node_modules/pkg/index.js"), "fetch('/api/chat');\n");
  writeFileSync(join(root, ".env"), "SECRET=fetch\n");
  return root;
}

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 1 } };

function message(content: unknown[], stop_reason: string): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason, stop_details: null, usage } as unknown as Anthropic.Message;
}
const text = (value: unknown, stop = "end_turn"): Anthropic.Message => message([{ type: "text", text: JSON.stringify(value) }], stop);
const toolUse = (id: string, name: string, input: Record<string, unknown>): Anthropic.Message => message([{ type: "tool_use", id, name, input }], "tool_use");

/** Plays scripted responses and records each request (a copy of its messages). */
function fakeCreate(responses: Anthropic.Message[]): { create: CreateMessage; requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create: CreateMessage = async (params) => {
    requests.push({ ...params, messages: [...params.messages] });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    return next;
  };
  return { create, requests };
}

const schema = { type: "object", properties: { pattern: { type: "string", minLength: 1 }, n: { type: "array", minItems: 1, items: { type: "integer", minimum: 0 } } }, required: ["pattern", "n"], additionalProperties: false };

describe("apiSchema", () => {
  it("drops constraints structured outputs reject, but not properties that share their names", () => {
    expect(apiSchema({ $schema: "x", ...schema })).toEqual({
      type: "object",
      properties: { pattern: { type: "string" }, n: { type: "array", items: { type: "integer" } } },
      required: ["pattern", "n"],
      additionalProperties: false,
    });
  });
});

describe("providerFrom", () => {
  it("defaults to Droid and rejects unknown names", () => {
    expect(providerFrom(undefined)).toBe("droid");
    expect(providerFrom("anthropic")).toBe("anthropic");
    expect(() => providerFrom("openai")).toThrow(/droid" or "anthropic/);
  });
});

describe("anthropicRunner", () => {
  it("asks for the JSON schema and returns the parsed answer", async () => {
    const { create, requests } = fakeCreate([text({ pattern: "x", n: [1] })]);
    const result = await anthropicRunner({ model: "claude-sonnet-5-5", create })("prompt", schema);
    expect(result).toEqual({ ok: true, value: { pattern: "x", n: [1] } });
    expect(requests[0]?.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: apiSchema(schema) } });
    expect(requests[0]?.tools).toBeUndefined();
  });

  it("reports refusals, cut-off answers and API errors as failed runs", async () => {
    const refusal = { ...message([], "refusal"), stop_details: { type: "refusal", category: "cyber", explanation: null } } as unknown as Anthropic.Message;
    const { create } = fakeCreate([refusal, text({}, "max_tokens")]);
    const run = anthropicRunner({ create });
    expect(await run("p", schema)).toEqual({ ok: false, error: "Claude declined (cyber)" });
    expect(await run("p", schema)).toMatchObject({ ok: false, error: expect.stringContaining("max_tokens") });
    expect(await run("p", schema)).toMatchObject({ ok: false, error: "no more scripted responses" });
  });
});

describe("read-only tools", () => {
  it("read, list, glob and grep inside the repo, never showing node_modules or .env", () => {
    const root = repo();
    expect(runReadTool(root, "Read", { file_path: "src/chat.ts", offset: 1, limit: 1 }).content).toBe("    2\t  return fetch('/api/chat');\n… 2 more lines (use offset 2)");
    expect(runReadTool(root, "LS", { directory_path: "." }).content).toBe("src/");
    expect(runReadTool(root, "Glob", { patterns: ["**/*"] }).content).toBe("src\nsrc/chat.ts");
    expect(runReadTool(root, "Grep", { pattern: "fetch" }).content).toBe("src/chat.ts:2:   return fetch('/api/chat');");
    expect(runReadTool(root, "Read", { file_path: "missing.ts" }).isError).toBe(true);
    expect(runReadTool(root, "Execute", {}).isError).toBe(true);
  });

  it("does not grep through symlinked files outside the repo or aliasing secrets", () => {
    const root = repo();
    const outside = mkdtempSync(join(tmpdir(), "catchup-outside-"));
    writeFileSync(join(outside, "outside.ts"), "fetch('synthetic-outside');");
    symlinkSync(join(outside, "outside.ts"), join(root, "src/escape.ts"));
    symlinkSync(join(root, ".env"), join(root, "src/config.ts"));
    try {
      expect(runReadTool(root, "Grep", { pattern: "fetch" }).content).toBe("src/chat.ts:2:   return fetch('/api/chat');");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("anthropicSession under agentRunner", () => {
  const run = (create: CreateMessage, root: string, logs: PassLog[], maxToolCalls = 20) =>
    agentRunner({ pass: "survey", cwd: root, open: anthropicSession(create), maxToolCalls, log: (entry) => logs.push(entry) })("map the repo", schema);

  it("runs read tools, sends their results back, and returns the answer with tokens logged", async () => {
    const root = repo();
    const logs: PassLog[] = [];
    const { create, requests } = fakeCreate([toolUse("t1", "Read", { file_path: "src/chat.ts" }), text({ pattern: "x", n: [] })]);
    expect(await run(create, root, logs)).toEqual({ ok: true, value: { pattern: "x", n: [] } });
    expect(requests[0]?.tools?.map((t) => ("name" in t ? t.name : ""))).toEqual(["Read", "LS", "Glob", "Grep"]);
    const result = requests[1]?.messages.at(-1)?.content;
    expect(result).toEqual([{ type: "tool_result", tool_use_id: "t1", content: expect.stringContaining("fetch('/api/chat')") }]);
    expect(logs[0]).toMatchObject({ outcome: "ok", toolCalls: [{ name: "Read", target: "src/chat.ts" }], tokens: { input: 20, output: 10, cacheRead: 4, thinking: 2 } });
  });

  it("never runs a read outside the repo or of a secrets file, and stops the run", async () => {
    const root = repo();
    for (const file_path of ["../../etc/passwd", ".env"]) {
      const logs: PassLog[] = [];
      const { create, requests } = fakeCreate([toolUse("t1", "Read", { file_path }), text({ pattern: "x", n: [] })]);
      expect(await run(create, root, logs)).toMatchObject({ ok: false, error: expect.stringContaining("forbidden tool use") });
      expect(logs[0]?.outcome).toBe("blocked");
      expect(requests).toHaveLength(1);
    }
  });

  it("keeps explicitly allowed digest roots searchable when checking grep matches", async () => {
    const root = repo();
    const digest = mkdtempSync(join(tmpdir(), "catchup-digest-"));
    writeFileSync(join(digest, "repo.md"), "Known digest text");
    const { create, requests } = fakeCreate([toolUse("t1", "Grep", { path: digest, pattern: "Known" }), text({ pattern: "x", n: [] })]);
    try {
      const result = await agentRunner({ pass: "ask", cwd: root, roots: [digest], open: anthropicSession(create), log: () => undefined })("p", schema);
      expect(result.ok).toBe(true);
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "tool_result", tool_use_id: "t1", content: expect.stringContaining("repo.md:1: Known digest text") },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(digest, { recursive: true, force: true });
    }
  });

  it("at the tool cap, asks for the answer in the same conversation", async () => {
    const root = repo();
    const logs: PassLog[] = [];
    const { create, requests } = fakeCreate([toolUse("t1", "LS", { directory_path: "." }), toolUse("t2", "LS", { directory_path: "src" }), text({ pattern: "x", n: [] })]);
    expect(await run(create, root, logs, 1)).toEqual({ ok: true, value: { pattern: "x", n: [] } });
    const last = requests[2]?.messages ?? [];
    expect(last.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "user"]);
    expect(last[4]?.content).toEqual([{ type: "tool_result", tool_use_id: "t2", content: "Stopped: no more tool calls.", is_error: true }]);
    expect(String(last[5]?.content)).toMatch(/Do not call any more tools/);
    expect(logs[0]?.outcome).toBe("capped");
  });
});
