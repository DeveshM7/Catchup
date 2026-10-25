import { basename, isAbsolute, relative, resolve } from "node:path";
import { createSession, OutputFormatType, ReasoningEffort, ToolConfirmationOutcome } from "@factory/droid-sdk/node";
import { DEFAULT_MODEL, type Runner, type RunResult } from "./droid.js";

/** The only tools an Understand or Ask agent may use (D36). */
export const READ_TOOLS = ["Read", "Grep", "Glob", "LS"];
/** Stays enabled whatever we disable; it only loads other tools, which are disabled. */
const INERT_TOOLS = ["ToolSearch"];
/** Every other Droid tool (SDK 0.10). A tool added later is caught by the session check below. */
export const DISABLED_TOOLS = [
  "AskUser", "ConnectApp", "Create", "CreateAutomation", "DeleteAutomation", "DismissHandoffItems", "Edit", "EditAutomation",
  "EndFeatureRun", "Execute", "ExitSpecMode", "FetchUrl", "GenerateDroid", "GenerateImage", "ListAutomations",
  "ListAutomationTemplates", "Loop", "ProposeMission", "ReadAutomation", "RunAutomation", "Skill", "StageSettingsChanges",
  "StartMissionRun", "Task", "TaskOutput", "TaskStop", "TodoWrite", "WebSearch",
];

export const DEFAULT_MAX_TOOL_CALLS = 20;
export const DEFAULT_MAX_MS = 120_000;
/** Time for the final answer once a cap is hit. */
const ANSWER_MS = 90_000;

export type ToolUseRequest = { name: string; input: Record<string, unknown> };
export type TokenCount = { input: number; output: number; cacheRead: number; cacheCreation: number; thinking: number };

export type AgentEvent =
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "result"; ok: boolean; output?: unknown; error?: string; tokens?: TokenCount };

/** The slice of a Droid session the runner uses; the SDK session is adapted to it, tests pass a fake. */
export type AgentSession = {
  tools(): Promise<{ id: string; allowed: boolean }[]>;
  ask(prompt: string, schema: Record<string, unknown>): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
};

export type SessionOptions = {
  cwd: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  disabledToolIds: string[];
  /** Answers Droid's permission prompts: true = allow once. */
  permit: (uses: ToolUseRequest[]) => boolean;
};
export type OpenSession = (options: SessionOptions) => Promise<AgentSession>;

export type ToolCallLog = { name: string; target: string; denied?: string };
export type PassLog = {
  pass: string;
  attempt: number;
  startedAt: string;
  durationMs: number;
  toolCalls: ToolCallLog[];
  tokens: TokenCount | null;
  /** capped = a cap was hit and the agent answered without more tools. */
  outcome: "ok" | "capped" | "failed" | "blocked";
  error?: string;
};

const PATH_KEYS = ["file_path", "directory_path", "path", "folder"];
const PATTERN_KEYS = ["patterns", "excludePatterns", "glob_pattern"];
const SECRET_FILE = /^\.env(\..+)?$/;
const NOT_SECRET = /\.(example|sample|template)$/;

function inside(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Why a tool use is not allowed, or undefined when it is: read tools only, inside the roots, no secrets. */
export function toolProblem(use: ToolUseRequest, cwd: string, roots: string[]): string | undefined {
  if (INERT_TOOLS.includes(use.name)) return undefined;
  if (!READ_TOOLS.includes(use.name)) return `${use.name} is not allowed (read-only agent: ${READ_TOOLS.join(", ")})`;
  for (const key of PATH_KEYS) {
    for (const value of strings(use.input[key])) {
      const path = resolve(cwd, value);
      if (!inside(path, roots)) return `${use.name} outside the repository: ${value}`;
      const name = basename(path);
      if (SECRET_FILE.test(name) && !NOT_SECRET.test(name)) return `${use.name} of a secrets file: ${value}`;
    }
  }
  for (const key of PATTERN_KEYS) {
    for (const value of strings(use.input[key])) {
      if (isAbsolute(value.replace(/^!/, "")) || value.split(/[\\/]/).includes("..")) return `${use.name} pattern leaves the repository: ${value}`;
    }
  }
  return undefined;
}

function targetOf(use: ToolUseRequest, cwd: string): string {
  for (const key of PATH_KEYS) {
    const value = strings(use.input[key])[0];
    if (value !== undefined) return relative(cwd, resolve(cwd, value)) || ".";
  }
  for (const key of ["pattern", ...PATTERN_KEYS]) {
    const value = strings(use.input[key])[0];
    if (value !== undefined) return value;
  }
  return "";
}

function addTokens(a: TokenCount | null, b: TokenCount | undefined): TokenCount | null {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    thinking: a.thinking + b.thinking,
  };
}

export type AgentRunnerOptions = {
  /** Pass name for the run log (`survey`, `journey:…`). */
  pass: string;
  cwd: string;
  /** Folders the agent may read; cwd is always included. */
  roots?: string[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxToolCalls?: number;
  maxMs?: number;
  open?: OpenSession;
  log: (entry: PassLog) => void;
  /** Each tool call as it happens (allowed or denied), e.g. to show the agent's steps live. */
  onTool?: (call: ToolCallLog) => void;
};

const ANSWER_NOW =
  "Stop exploring: your tool budget for this task is used up. Do not call any more tools. Answer now with the JSON object, from what you have learned.";

type Turn = { result?: Extract<AgentEvent, { kind: "result" }>; capped: boolean; blocked?: string };

/**
 * A read-only Droid agent as a `Runner` (D36): only Read/Grep/Glob/LS inside the repo, a cap on tool calls and
 * time, and one log entry per attempt. Write tools are disabled in the session, denied by the permission handler,
 * and any call that slips through stops the run.
 */
export function agentRunner(options: AgentRunnerOptions): Runner {
  const cwd = resolve(options.cwd);
  const roots = [cwd, ...(options.roots ?? []).map((r) => resolve(r))];
  const maxCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const open = options.open ?? droidSession;
  let attempt = 0;

  return async (prompt, schema): Promise<RunResult> => {
    attempt += 1;
    const started = Date.now();
    const log: PassLog = { pass: options.pass, attempt, startedAt: new Date(started).toISOString(), durationMs: 0, toolCalls: [], tokens: null, outcome: "failed" };
    const finish = (result: RunResult, outcome: PassLog["outcome"]): RunResult => {
      log.durationMs = Date.now() - started;
      log.outcome = outcome;
      if (!result.ok) log.error = result.error;
      options.log(log);
      return result;
    };
    const permit = (uses: ToolUseRequest[]): boolean => uses.every((use) => toolProblem(use, cwd, roots) === undefined);
    let session: AgentSession | undefined;
    try {
      session = await open({ cwd, model: options.model ?? DEFAULT_MODEL, reasoningEffort: options.reasoningEffort ?? ReasoningEffort.Low, disabledToolIds: DISABLED_TOOLS, permit });
      const extra = (await session.tools()).filter((t) => t.allowed && !READ_TOOLS.includes(t.id) && !INERT_TOOLS.includes(t.id)).map((t) => t.id);
      if (extra.length) return finish({ ok: false, error: `the agent session allows tools that should be disabled: ${extra.join(", ")}` }, "blocked");

      const consume = async (text: string, calls: number, ms: number): Promise<Turn> => {
        const current = session!;
        const turn: Turn = { capped: false };
        let used = 0;
        const stop = (): void => {
          turn.capped = true;
          void current.interrupt().catch(() => undefined);
        };
        const timer = setTimeout(stop, ms);
        try {
          for await (const event of current.ask(text, schema)) {
            if (event.kind === "result") {
              turn.result = event;
              log.tokens = addTokens(log.tokens, event.tokens);
              break;
            }
            const use = { name: event.name, input: event.input };
            const problem = toolProblem(use, cwd, roots);
            const call: ToolCallLog = { name: event.name, target: targetOf(use, cwd), ...(problem ? { denied: problem } : {}) };
            log.toolCalls.push(call);
            options.onTool?.(call);
            if (problem) {
              turn.blocked = problem;
              void current.interrupt().catch(() => undefined);
              continue;
            }
            used += 1;
            if (used > calls && !turn.capped) stop();
          }
        } finally {
          clearTimeout(timer);
        }
        return turn;
      };

      let turn = await consume(prompt, maxCalls, maxMs);
      let capped = false;
      if (!turn.blocked && turn.capped && !turn.result?.ok) {
        capped = true;
        turn = await consume(ANSWER_NOW, 0, ANSWER_MS);
        if (turn.capped && !turn.blocked) return finish({ ok: false, error: "the agent kept exploring after its tool budget ran out" }, "capped");
      }
      if (turn.blocked) return finish({ ok: false, error: `the agent tried a forbidden tool use (${turn.blocked}); use only ${READ_TOOLS.join(", ")} inside the repository` }, "blocked");
      const result = turn.result;
      if (!result) return finish({ ok: false, error: "the agent session ended without a result" }, "failed");
      if (!result.ok) return finish({ ok: false, error: result.error ?? "the agent run failed" }, "failed");
      return finish({ ok: true, value: result.output }, capped ? "capped" : "ok");
    } catch (error) {
      return finish({ ok: false, error: error instanceof Error ? error.message : String(error) }, "failed");
    } finally {
      await session?.close().catch(() => undefined);
    }
  };
}

/** Adapts a real Droid session to `AgentSession`. */
export const droidSession: OpenSession = async (options) => {
  const session = await createSession({
    cwd: options.cwd,
    modelId: options.model,
    reasoningEffort: options.reasoningEffort,
    disabledToolIds: options.disabledToolIds,
    disableBuiltinSkills: true,
    permissionHandler: (params) =>
      options.permit(params.toolUses.map((t) => ({ name: t.toolUse.name, input: t.toolUse.input })))
        ? ToolConfirmationOutcome.ProceedOnce
        : ToolConfirmationOutcome.Cancel,
  });
  return {
    tools: async () => (await session.listTools()).map((t) => ({ id: t.id, allowed: t.allowed })),
    async *ask(prompt, schema) {
      for await (const message of session.stream(prompt, { outputFormat: { type: OutputFormatType.JsonSchema, schema } })) {
        if (message.type === "tool_call") yield { kind: "tool", name: message.name, input: message.input };
        else if (message.type === "result") {
          const usage = message.tokenUsage;
          yield {
            kind: "result",
            ok: message.success,
            output: message.structuredOutput,
            ...(message.success ? {} : { error: message.structuredOutputError?.message ?? message.error?.message ?? `run ${message.subtype}` }),
            ...(usage
              ? { tokens: { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheCreation: usage.cacheCreationTokens, thinking: usage.thinkingTokens } }
              : {}),
          };
        }
      }
    },
    interrupt: () => session.interrupt(),
    close: () => session.close(),
  };
};

