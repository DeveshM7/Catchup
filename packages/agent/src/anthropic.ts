import { globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { READ_TOOLS, type AgentEvent, type AgentSession, type OpenSession, type SessionOptions, type TokenCount } from "./agent.js";
import { DEFAULT_MODEL, type Runner } from "./droid.js";

/** Claude straight through the Anthropic API (D51), as an alternative to Droid. Same Runner / AgentSession contracts. */

/** One Messages API call; injected so tests never reach the network. */
export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming, options: { signal?: AbortSignal }) => Promise<Anthropic.Message>;

const MAX_TOKENS = 16000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

function defaultCreate(): CreateMessage {
  // Credentials from the environment: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
  const client = new Anthropic();
  return (params, options) => client.messages.create(params, options);
}

function effortOf(value: string | undefined): Effort {
  return EFFORTS.find((e) => e === value) ?? "low";
}

/** Keywords structured outputs don't accept; Zod still checks them on our side (askStructured). */
const UNSUPPORTED = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "pattern"]);

/** The JSON schema as the API takes it: unsupported constraints removed (property names are left alone). */
export function apiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(apiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, apiSchema(sub)]));
    } else if (!UNSUPPORTED.has(key)) out[key] = apiSchema(value);
  }
  return out;
}

function addUsage(total: TokenCount, usage: Anthropic.Usage): void {
  total.input += usage.input_tokens;
  total.output += usage.output_tokens;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheCreation += usage.cache_creation_input_tokens ?? 0;
  total.thinking += usage.output_tokens_details?.thinking_tokens ?? 0;
}

/** The final answer as JSON, or why there is none. */
function answerOf(response: Anthropic.Message): { ok: true; value: unknown } | { ok: false; error: string } {
  if (response.stop_reason === "refusal") return { ok: false, error: `Claude declined${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}` };
  if (response.stop_reason === "max_tokens") return { ok: false, error: `the answer hit max_tokens (${MAX_TOKENS})` };
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: `the answer is not JSON: ${text.slice(0, 200)}` };
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type AnthropicRunnerOptions = { model?: string; effort?: string; create?: CreateMessage };

/** One structured-output call with no tools (the `explain` jobs), like `droidRunner`. */
export function anthropicRunner(options: AnthropicRunnerOptions = {}): Runner {
  const create = options.create ?? defaultCreate();
  return async (prompt, schema) => {
    try {
      const response = await create(
        {
          model: options.model ?? DEFAULT_MODEL,
          max_tokens: MAX_TOKENS,
          output_config: { effort: effortOf(options.effort), format: { type: "json_schema", schema: apiSchema(schema) as Record<string, unknown> } },
          messages: [{ role: "user", content: prompt }],
        },
        {},
      );
      return answerOf(response);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  };
}

// ---------- Read-only tools ----------

const MAX_READ_LINES = 2000;
const MAX_MATCHES = 200;
const MAX_LISTED = 500;
const MAX_FILE_BYTES = 1_000_000;
const NEVER = new Set(["node_modules", ".git"]);
const SECRET = (path: string): boolean => /^\.env(\..+)?$/.test(basename(path)) && !/\.(example|sample|template)$/.test(path);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** Definitions use the input keys `toolProblem` checks (file_path, directory_path, path, patterns, glob_pattern). */
export const READ_TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "Read",
    description: "Read a text file in the repository. Lines are numbered. Use offset (0-based line) and limit for long files.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string", description: "Repo-relative or absolute path" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "LS",
    description: "List the entries of a folder in the repository (folders end with /).",
    input_schema: { type: "object", properties: { directory_path: { type: "string" } }, required: ["directory_path"], additionalProperties: false },
  },
  {
    name: "Glob",
    description: "Find repository files matching glob patterns, e.g. [\"src/**/*.ts\"].",
    input_schema: { type: "object", properties: { patterns: { type: "array", items: { type: "string" } } }, required: ["patterns"], additionalProperties: false },
  },
  {
    name: "Grep",
    description: "Search file contents with a JavaScript regular expression. Optional: path (a folder or file to search in) and glob_pattern (which files, e.g. \"**/*.ts\").",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" }, glob_pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

const skipped = (rel: string): boolean => rel.split(/[\\/]/).some((s) => NEVER.has(s)) || SECRET(rel);

function readTool(cwd: string, input: Record<string, unknown>): string {
  const path = resolve(cwd, str(input.file_path) ?? "");
  const lines = readFileSync(path, "utf8").split("\n");
  const offset = int(input.offset) ?? 0;
  const limit = Math.min(int(input.limit) ?? MAX_READ_LINES, MAX_READ_LINES);
  const shown = lines.slice(offset, offset + limit).map((line, i) => `${String(offset + i + 1).padStart(5)}\t${line}`);
  const rest = lines.length - offset - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n… ${rest} more lines (use offset ${offset + shown.length})` : "");
}

function lsTool(cwd: string, input: Record<string, unknown>): string {
  const dir = resolve(cwd, str(input.directory_path) ?? ".");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !NEVER.has(e.name) && !SECRET(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join("\n");
}

function globFiles(cwd: string, patterns: string[]): string[] {
  return globSync(patterns, { cwd, exclude: (path: string) => NEVER.has(basename(path)) })
    .filter((p) => !skipped(p))
    .sort();
}

function globTool(cwd: string, input: Record<string, unknown>): string {
  const patterns = Array.isArray(input.patterns) ? input.patterns.filter((p): p is string => typeof p === "string") : [];
  const found = globFiles(cwd, patterns);
  return found.length === 0 ? "(no matches)" : found.slice(0, MAX_LISTED).join("\n") + (found.length > MAX_LISTED ? `\n… ${found.length - MAX_LISTED} more` : "");
}

function grepTool(cwd: string, input: Record<string, unknown>): string {
  const regex = new RegExp(str(input.pattern) ?? "");
  const base = resolve(cwd, str(input.path) ?? ".");
  const files = statSync(base).isFile() ? [base] : globFiles(base, [str(input.glob_pattern) ?? "**/*"]).map((f) => join(base, f));
  const hits: string[] = [];
  for (const file of files) {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes("\u0000")) continue; // binary
    const shown = relative(cwd, file) || file;
    text.split("\n").forEach((line, i) => {
      if (hits.length < MAX_MATCHES && regex.test(line)) hits.push(`${shown}:${i + 1}: ${line.slice(0, 300)}`);
    });
    if (hits.length >= MAX_MATCHES) break;
  }
  return hits.length === 0 ? "(no matches)" : hits.join("\n") + (hits.length >= MAX_MATCHES ? `\n… stopped at ${MAX_MATCHES} matches` : "");
}

/** Runs one read-only tool; paths were already checked by the permission handler. */
export function runReadTool(cwd: string, name: string, input: Record<string, unknown>): { content: string; isError: boolean } {
  try {
    const run = { Read: readTool, LS: lsTool, Glob: globTool, Grep: grepTool }[name];
    if (!run) return { content: `unknown tool ${name}`, isError: true };
    return { content: run(cwd, input) || "(empty)", isError: false };
  } catch (e) {
    return { content: errorText(e), isError: true };
  }
}

// ---------- Agent session ----------

/**
 * A read-only agent session over the Messages API, for `agentRunner` (D45 locks unchanged): only our four read tools
 * exist, each use goes through `permit` before it runs, and `interrupt` aborts the call in flight. The conversation
 * carries over between `ask` calls, so "answer now without tools" sees what was read.
 */
export function anthropicSession(create: CreateMessage = defaultCreate()): OpenSession {
  return async (options: SessionOptions): Promise<AgentSession> => {
    const messages: Anthropic.MessageParam[] = [];
    let controller: AbortController | undefined;
    let stopped = false;
    return {
      tools: async () => READ_TOOLS.map((id) => ({ id, allowed: true })),
      async *ask(prompt, schema): AsyncIterable<AgentEvent> {
        stopped = false;
        messages.push({ role: "user", content: prompt });
        const tokens: TokenCount = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 };
        for (;;) {
          controller = new AbortController();
          let response: Anthropic.Message;
          try {
            response = await create(
              {
                model: options.model,
                max_tokens: MAX_TOKENS,
                tools: READ_TOOL_DEFS,
                output_config: { effort: effortOf(String(options.reasoningEffort)), format: { type: "json_schema", schema: apiSchema(schema) as Record<string, unknown> } },
                messages,
              },
              { signal: controller.signal },
            );
          } catch (e) {
            if (!stopped) yield { kind: "result", ok: false, error: errorText(e), tokens };
            return;
          }
          addUsage(tokens, response.usage);
          messages.push({ role: "assistant", content: response.content });
          const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (response.stop_reason === "tool_use" && uses.length > 0) {
            const results: Anthropic.ToolResultBlockParam[] = [];
            for (const use of uses) {
              const input = (use.input ?? {}) as Record<string, unknown>;
              yield { kind: "tool", name: use.name, input };
              const result = stopped
                ? { content: "Stopped: no more tool calls.", isError: true }
                : options.permit([{ name: use.name, input }])
                  ? runReadTool(options.cwd, use.name, input)
                  : { content: `Denied: ${use.name} is not allowed here (read-only, inside the repository).`, isError: true };
              results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
            }
            // Every tool_use gets its result, so the conversation stays valid for the next ask.
            messages.push({ role: "user", content: results });
            if (stopped) return;
            continue;
          }
          if (response.stop_reason === "pause_turn") continue;
          const answer = answerOf(response);
          yield answer.ok ? { kind: "result", ok: true, output: answer.value, tokens } : { kind: "result", ok: false, error: answer.error, tokens };
          return;
        }
      },
      interrupt: async () => {
        stopped = true;
        controller?.abort();
      },
      close: async () => undefined,
    };
  };
}

/** Which way Claude is reached (D51): `CATCHUP_PROVIDER=droid` (default) or `anthropic`. */
export type Provider = "droid" | "anthropic";

export function providerFrom(value: string | undefined): Provider {
  if (value === undefined || value === "" || value === "droid") return "droid";
  if (value === "anthropic") return "anthropic";
  throw new Error(`CATCHUP_PROVIDER must be "droid" or "anthropic", not "${value}"`);
}
