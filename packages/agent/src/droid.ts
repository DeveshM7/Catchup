import { OutputFormatType, ReasoningEffort, run } from "@factory/droid-sdk/node";
import type * as z from "zod/v4";
import { jsonSchemaOf } from "./schemas.js";

/** Claude via Droid (D12). Sonnet 5.5 chosen for flows and labels (D23). */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export type RunResult = { ok: true; value: unknown } | { ok: false; error: string };
/** One structured-output call; injected so tests never reach the network. */
export type Runner = (prompt: string, schema: Record<string, unknown>) => Promise<RunResult>;

export type DroidRunnerOptions = { cwd: string; model?: string; reasoningEffort?: ReasoningEffort };

const NO_TOOLS =
  "Answer only from the material in this message. Do not use any tools, do not read files, do not run commands. Reply with the JSON object only.";

export function droidRunner(options: DroidRunnerOptions): Runner {
  return async (prompt, schema) => {
    const result = await run(`${prompt}\n\n${NO_TOOLS}`, {
      cwd: options.cwd,
      modelId: options.model ?? DEFAULT_MODEL,
      reasoningEffort: options.reasoningEffort ?? ReasoningEffort.Low,
      autoRejectPermissionRequests: true,
      outputFormat: { type: OutputFormatType.JsonSchema, schema },
    });
    if (!result.success) {
      return { ok: false, error: result.structuredOutputError?.message ?? result.error?.message ?? `run failed: ${result.subtype}` };
    }
    return { ok: true, value: result.structuredOutput };
  };
}

/** The Claude run itself failed twice (API error, billing, network, cap): not a validation problem. */
export class RunError extends Error {
  constructor(
    readonly job: string,
    readonly reason: string,
  ) {
    super(`${job}: the Claude run failed twice: ${reason}`);
  }
}

export class ExplainError extends Error {
  constructor(
    readonly job: string,
    readonly problems: string[],
  ) {
    super(`${job}: Claude's answer failed validation twice:\n  - ${problems.join("\n  - ")}`);
  }
}

export type AskOptions<T> = {
  job: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Checks against the facts; returns problems (empty = valid). */
  check: (value: T) => string[];
  runner: Runner;
  onCall?: (job: string, attempt: number) => void;
  /** Called with the validator's problems before the retry. */
  onRejected?: (job: string, problems: string[]) => void;
};

function problemsOf<T>(result: RunResult, options: AskOptions<T>): { value?: T; problems: string[]; runFailed?: true } {
  if (!result.ok) return { problems: [result.error], runFailed: true };
  const parsed = options.schema.safeParse(result.value);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  return { value: parsed.data, problems: options.check(parsed.data) };
}

/** Structured call → schema check → facts check; one retry with the problems listed; then fail loudly. */
export async function askStructured<T>(options: AskOptions<T>): Promise<T> {
  const schema = jsonSchemaOf(options.schema);
  options.onCall?.(options.job, 1);
  const first = problemsOf(await options.runner(options.prompt, schema), options);
  if (first.value !== undefined && first.problems.length === 0) return first.value;
  options.onRejected?.(options.job, first.problems);
  // A failed run (API error, cap) is retried as it was; a rejected answer is retried with the problems listed.
  const retryPrompt = first.runFailed ? options.prompt : [
    options.prompt,
    "",
    "Your previous answer was rejected by the validator:",
    ...first.problems.map((p) => `- ${p}`),
    ...(first.value !== undefined ? ["", "Previous answer:", JSON.stringify(first.value)] : []),
    "",
    "Return a corrected answer that fixes every problem.",
  ].join("\n");
  options.onCall?.(options.job, 2);
  const second = problemsOf(await options.runner(retryPrompt, schema), options);
  if (second.value !== undefined && second.problems.length === 0) return second.value;
  if (second.runFailed) throw new RunError(options.job, second.problems[0] ?? "unknown error");
  throw new ExplainError(options.job, second.problems);
}
