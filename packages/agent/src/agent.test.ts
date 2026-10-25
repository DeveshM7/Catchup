import { describe, expect, it } from "vitest";
import { agentRunner, DISABLED_TOOLS, READ_TOOLS, toolProblem, type AgentEvent, type AgentSession, type OpenSession, type PassLog, type SessionOptions } from "./agent.js";

const repo = "/work/repo";
const digest = "/work/repo/.catchup/digest/abc";

type Script = (prompt: string, turn: number, state: { interrupted: boolean }) => AgentEvent[];

/** A fake Droid session that plays scripted events; `interrupt` ends the current turn like the real one. */
function fakeOpen(script: Script, tools?: { id: string; allowed: boolean }[]): { open: OpenSession; seen: SessionOptions[]; prompts: string[]; closed: number[] } {
  const seen: SessionOptions[] = [];
  const prompts: string[] = [];
  const closed: number[] = [];
  const open: OpenSession = async (options) => {
    seen.push(options);
    const index = seen.length;
    let turn = 0;
    const state = { interrupted: false };
    const session: AgentSession = {
      tools: async () => tools ?? [...READ_TOOLS, "ToolSearch"].map((id) => ({ id, allowed: true })).concat(options.disabledToolIds.map((id) => ({ id, allowed: false }))),
      async *ask(prompt) {
        prompts.push(prompt);
        turn += 1;
        state.interrupted = false;
        for (const event of script(prompt, turn, state)) {
          if (state.interrupted) {
            yield { kind: "result", ok: false, error: "interrupted" };
            return;
          }
          await Promise.resolve();
          yield event;
        }
      },
      interrupt: async () => {
        state.interrupted = true;
      },
      close: async () => {
        closed.push(index);
      },
    };
    return session;
  };
  return { open, seen, prompts, closed };
}

const read = (file_path: string): AgentEvent => ({ kind: "tool", name: "Read", input: { file_path } });
const done = (output: unknown): AgentEvent => ({ kind: "result", ok: true, output, tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, thinking: 1 } });

function runner(script: Script, extra: Partial<Parameters<typeof agentRunner>[0]> = {}, tools?: { id: string; allowed: boolean }[]) {
  const fake = fakeOpen(script, tools);
  const logs: PassLog[] = [];
  const run = agentRunner({ pass: "survey", cwd: repo, roots: [digest], open: fake.open, log: (l) => logs.push(l), ...extra });
  return { run, logs, ...fake };
}

describe("toolProblem", () => {
  it("allows read tools inside the repo and digest", () => {
    expect(toolProblem({ name: "Read", input: { file_path: "app/page.tsx" } }, repo, [repo])).toBeUndefined();
    expect(toolProblem({ name: "LS", input: { directory_path: `${digest}` } }, repo, [repo, digest])).toBeUndefined();
    expect(toolProblem({ name: "Grep", input: { pattern: "a..b", path: repo } }, repo, [repo])).toBeUndefined();
    expect(toolProblem({ name: "Glob", input: { patterns: ["**/*.ts", "!node_modules/**"] } }, repo, [repo])).toBeUndefined();
  });

  it("denies other tools, paths outside, secrets and escaping patterns", () => {
    expect(toolProblem({ name: "Execute", input: { command: "rm -rf /" } }, repo, [repo])).toMatch(/not allowed/);
    expect(toolProblem({ name: "Create", input: { file_path: "x.ts" } }, repo, [repo])).toMatch(/not allowed/);
    expect(toolProblem({ name: "Read", input: { file_path: "/etc/passwd" } }, repo, [repo])).toMatch(/outside/);
    expect(toolProblem({ name: "Read", input: { file_path: "../other/x.ts" } }, repo, [repo])).toMatch(/outside/);
    expect(toolProblem({ name: "Read", input: { file_path: ".env.local" } }, repo, [repo])).toMatch(/secrets/);
    expect(toolProblem({ name: "Read", input: { file_path: ".env.example" } }, repo, [repo])).toBeUndefined();
    expect(toolProblem({ name: "Glob", input: { patterns: ["../**/*.ts"] } }, repo, [repo])).toMatch(/leaves/);
  });
});

describe("agentRunner", () => {
  it("disables every non-read tool and answers permission prompts read-only", async () => {
    const { run, seen } = runner(() => [done({ n: 1 })]);
    await run("p", {});
    const options = seen[0]!;
    expect(options.disabledToolIds).toEqual(DISABLED_TOOLS);
    for (const id of ["Execute", "Create", "Edit", "Task", "FetchUrl", "WebSearch"]) expect(options.disabledToolIds).toContain(id);
    expect(options.permit([{ name: "Read", input: { file_path: `${repo}/a.ts` } }])).toBe(true);
    expect(options.permit([{ name: "Execute", input: { command: "ls" } }])).toBe(false);
    expect(options.permit([{ name: "Edit", input: { file_path: `${repo}/a.ts` } }])).toBe(false);
  });

  it("returns the structured answer and logs calls, tokens and time", async () => {
    const { run, logs, closed } = runner(() => [read(`${digest}/repo.md`), read(`${repo}/app/x.ts`), done({ n: 1 })]);
    expect(await run("p", {})).toEqual({ ok: true, value: { n: 1 } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ pass: "survey", attempt: 1, outcome: "ok", tokens: { input: 10, output: 5 } });
    expect(logs[0]!.toolCalls.map((c) => c.target)).toEqual([".catchup/digest/abc/repo.md", "app/x.ts"]);
    expect(closed).toEqual([1]);
  });

  it("stops a run that uses a forbidden tool", async () => {
    const { run, logs } = runner(() => [read(`${repo}/a.ts`), { kind: "tool", name: "Execute", input: { command: "rm x" } }, done({ n: 1 })]);
    const result = await run("p", {});
    expect(result.ok).toBe(false);
    expect(logs[0]!.outcome).toBe("blocked");
    expect(logs[0]!.toolCalls[1]!.denied).toMatch(/Execute is not allowed/);
  });

  it("refuses a session where a non-read tool is still enabled", async () => {
    const { run, logs, prompts } = runner(() => [done({})], {}, [{ id: "Read", allowed: true }, { id: "Execute", allowed: true }]);
    expect(await run("p", {})).toMatchObject({ ok: false, error: expect.stringMatching(/Execute/) });
    expect(prompts).toHaveLength(0);
    expect(logs[0]!.outcome).toBe("blocked");
  });

  it("caps tool calls, then asks for the answer without tools", async () => {
    const { run, logs, prompts } = runner(
      (_p, turn) => (turn === 1 ? Array.from({ length: 10 }, (_, i) => read(`${repo}/f${i}.ts`)).concat(done({ n: 0 })) : [done({ n: 2 })]),
      { maxToolCalls: 3 },
    );
    expect(await run("p", {})).toEqual({ ok: true, value: { n: 2 } });
    expect(prompts[1]).toMatch(/Do not call any more tools/);
    expect(logs[0]!.outcome).toBe("capped");
    expect(logs[0]!.toolCalls.length).toBe(4);
  });

  it("fails when the agent keeps exploring after the cap", async () => {
    const { run, logs } = runner((_p, turn) => (turn === 1 ? [read(`${repo}/a.ts`), read(`${repo}/b.ts`), done({})] : [read(`${repo}/c.ts`), done({})]), { maxToolCalls: 1 });
    expect((await run("p", {})).ok).toBe(false);
    expect(logs[0]!.outcome).toBe("capped");
  });

  it("caps wall time", async () => {
    const slow: Script = (_p, turn) => (turn === 1 ? [read(`${repo}/a.ts`)] : [done({ n: 3 })]);
    const fake = fakeOpen(slow);
    const logs: PassLog[] = [];
    const open: OpenSession = async (options) => {
      const session = await fake.open(options);
      return {
        ...session,
        async *ask(prompt, schema) {
          const turn = fake.prompts.length + 1;
          for await (const event of session.ask(prompt, schema)) yield event;
          if (turn === 1) {
            await new Promise((r) => setTimeout(r, 50));
            yield { kind: "result", ok: false, error: "interrupted" } as AgentEvent;
          }
        },
      };
    };
    const run = agentRunner({ pass: "t", cwd: repo, open, log: (l) => logs.push(l), maxMs: 10 });
    expect(await run("p", {})).toEqual({ ok: true, value: { n: 3 } });
    expect(logs[0]!.outcome).toBe("capped");
  });

  it("counts attempts across retries", async () => {
    const { run, logs } = runner(() => [done({})]);
    await run("p", {});
    await run("p again", {});
    expect(logs.map((l) => l.attempt)).toEqual([1, 2]);
  });
});
