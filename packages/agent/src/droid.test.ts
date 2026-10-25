import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { askStructured, ExplainError, type Runner } from "./droid.js";

const schema = z.object({ n: z.number() });
const fake = (answers: unknown[]): { runner: Runner; prompts: string[] } => {
  const prompts: string[] = [];
  const runner: Runner = async (prompt) => {
    prompts.push(prompt);
    return { ok: true, value: answers[prompts.length - 1] };
  };
  return { runner, prompts };
};
const check = (v: { n: number }): string[] => (v.n > 0 ? [] : ["n must be positive"]);

describe("askStructured", () => {
  it("returns a valid first answer", async () => {
    const { runner, prompts } = fake([{ n: 1 }]);
    expect(await askStructured({ job: "t", prompt: "p", schema, check, runner })).toEqual({ n: 1 });
    expect(prompts).toHaveLength(1);
  });

  it("retries once with the problems listed", async () => {
    const { runner, prompts } = fake([{ n: -1 }, { n: 2 }]);
    const rejected: string[][] = [];
    const onRejected = (_job: string, problems: string[]): number => rejected.push(problems);
    expect(await askStructured({ job: "t", prompt: "p", schema, check, runner, onRejected })).toEqual({ n: 2 });
    expect(rejected).toEqual([["n must be positive"]]);
    expect(prompts[1]).toContain("- n must be positive");
    expect(prompts[1]).toContain('{"n":-1}');
  });

  it("fails loudly after the retry, including schema errors", async () => {
    const { runner } = fake([{ n: "x" }, { n: 0 }]);
    await expect(askStructured({ job: "t", prompt: "p", schema, check, runner })).rejects.toThrow(ExplainError);
    await expect(askStructured({ job: "t", prompt: "p", schema, check, runner: fake([{}, {}]).runner })).rejects.toThrow(/n: /);
  });

  it("retries a failed run with the same prompt and reports it as a run failure, not a validation one", async () => {
    const prompts: string[] = [];
    const runner = async (prompt: string) => (prompts.push(prompt), { ok: false as const, error: "400 credit balance is too low" });
    await expect(askStructured({ job: "j", prompt: "P", schema: z.object({ a: z.string() }), check: () => [], runner })).rejects.toThrow("j: the Claude run failed twice: 400 credit balance is too low");
    expect(prompts).toEqual(["P", "P"]);
  });
});

