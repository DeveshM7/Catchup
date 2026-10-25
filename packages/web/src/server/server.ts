import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Understanding } from "@catchup/agent";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type { AskEvent, AskRequest, AskStep, ChangeSetView, MapGraph, PreviewView, SourceView, TimelapseView, TreeData } from "../shared/types.js";
import { commitsBetween } from "@catchup/history";
import { listTimelapses, loadChanges, loadTimelapse } from "@catchup/store";
import { Preview, type PreviewResult } from "./preview.js";
import { buildMap, callsOf, treeView, type AskContext, type DashboardInputs } from "./data.js";
import { canvasGraph, treeData } from "./understanding.js";

const UI_ROOT = fileURLToPath(new URL("../ui", import.meta.url));
const MAX_SOURCE_LINES = 200;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function reply<T>(res: ServerResponse, work: Promise<T | undefined>, missing: string): void {
  work.then(
    (value) => (value === undefined ? send(res, 404, { error: missing }) : send(res, 200, value)),
    (e: unknown) => send(res, 500, { error: errorText(e) }),
  );
}

export function sourceOf(inputs: DashboardInputs, id: string): SourceView | undefined {
  const fact = inputs.facts.functions.find((f) => f.id === id);
  if (!fact) return undefined;
  let text: string;
  try {
    text = readFileSync(join(inputs.repoRoot, fact.file), "utf8");
  } catch {
    return undefined;
  }
  const end = Math.min(fact.endLine, fact.startLine + MAX_SOURCE_LINES - 1);
  return { id, file: fact.file, startLine: fact.startLine, endLine: end, text: text.split("\n").slice(fact.startLine - 1, end).join("\n") };
}

/**
 * The understanding tree as the server holds it: views and canvases are computed from it on demand, and the Open
 * pass replaces it. Opens run one at a time (each one saves the whole tree); asking for a node already being
 * opened waits for that run.
 */
export class TreeState {
  private current: Understanding | undefined;
  private canvases = new Map<string, Promise<MapGraph | undefined>>();
  private opening = new Map<string, Promise<TreeData>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly inputs: DashboardInputs) {
    this.current = inputs.understanding;
  }

  understanding(): Understanding | undefined {
    return this.current;
  }

  data(): TreeData | undefined {
    return this.current && treeData({ ...this.inputs, understanding: this.current });
  }

  canvas(id: string): Promise<MapGraph | undefined> {
    const u = this.current;
    if (!u) return Promise.resolve(undefined);
    const cached = this.canvases.get(id) ?? canvasGraph({ ...this.inputs, understanding: u }, id);
    this.canvases.set(id, cached);
    return cached;
  }

  open(id: string): Promise<TreeData> {
    const running = this.opening.get(id);
    if (running) return running;
    const run = this.queue.then(async () => {
      const u = this.current;
      if (!u) throw new Error("no understanding yet; run: catchup understand <path>");
      if (!u.nodes[id]) throw new Error(`no node "${id}"`);
      if (u.nodes[id].children === "unopened") {
        if (!this.inputs.open) throw new Error("opening nodes is not available here");
        this.current = await this.inputs.open(u, id);
        this.canvases.clear();
      }
      return this.data()!;
    });
    this.queue = run.catch(() => undefined);
    this.opening.set(id, run);
    void run.finally(() => this.opening.delete(id)).catch(() => undefined);
    return run;
  }
}

const MAX_QUESTION = 2000;
const MAX_BODY = 64_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** The request as sent, checked: a non-empty question, an optional node id, a short history. */
export function parseAsk(body: string): AskRequest {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question || question.length > MAX_QUESTION) throw new Error(`question must be 1–${MAX_QUESTION} characters`);
  const history = Array.isArray(raw.history)
    ? raw.history.flatMap((t: unknown) => {
        const turn = t as Record<string, unknown>;
        return typeof turn?.question === "string" && typeof turn.answer === "string" ? [{ question: turn.question, answer: turn.answer }] : [];
      })
    : [];
  const c = raw.changes as Record<string, unknown> | string | undefined;
  const changes =
    c === "preview" ? ("preview" as const) : c && typeof c === "object" && typeof c.from === "string" && typeof c.to === "string" ? { from: c.from, to: c.to } : undefined;
  return { question, ...(typeof raw.node === "string" && raw.node ? { node: raw.node } : {}), ...(history.length ? { history } : {}), ...(changes ? { changes } : {}) };
}

/** The change a question is about (Build 8): the live preview's, or a stored change set and its commits. */
function changeContext(inputs: DashboardInputs, preview: Preview | undefined, changes: AskRequest["changes"]): AskContext | undefined {
  if (changes === undefined) return undefined;
  if (changes === "preview") {
    const result = preview?.current().result;
    if (!result) throw new Error("the live preview has no result yet");
    return {
      label: `uncommitted changes (working tree against HEAD ${inputs.facts.sha.slice(0, 7)})`,
      changes: result.changes,
      commits: [],
      after: { facts: result.facts, understanding: result.understanding },
    };
  }
  const set = loadChanges<ChangeSetView>(inputs.repoRoot, changes.from, changes.to);
  if (!set) throw new Error(`no change set ${changes.from.slice(0, 9)}..${changes.to.slice(0, 9)}; run: catchup diff <path> ${changes.from.slice(0, 9)} ${changes.to.slice(0, 9)}`);
  const commits = commitsBetween(inputs.repoRoot, changes.from, changes.to).map(({ sha, date, subject }) => ({ sha, date, subject }));
  return { label: `${changes.from.slice(0, 7)} → ${changes.to.slice(0, 7)}`, changes: set, commits };
}

/** Streams an Ask run as newline-delimited JSON events: each tool call, then the answer (or an error). */
async function streamAsk(inputs: DashboardInputs, state: TreeState, preview: Preview | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const write = (event: AskEvent): void => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson");
  try {
    const request = parseAsk(await readBody(req));
    const u = state.understanding();
    if (!u) throw new Error("no understanding yet; run: catchup understand <path>");
    if (!inputs.ask) throw new Error("asking is not available here");
    if (request.node !== undefined && !u.nodes[request.node]) throw new Error(`no node "${request.node}"`);
    const steps: AskStep[] = [];
    const context = changeContext(inputs, preview, request.changes);
    const reply = await inputs.ask(
      u,
      request,
      (step) => {
        steps.push(step);
        write({ type: "step", step });
      },
      context,
    );
    write({ type: "answer", reply: { ...reply, steps } });
  } catch (e) {
    write({ type: "error", error: errorText(e) });
  }
  res.end();
}

/** The preview as the UI reads it; tree data and canvases are computed once per result. */
class PreviewApi {
  private views = new WeakMap<PreviewResult, TreeData>();
  private canvases = new WeakMap<PreviewResult, Map<string, Promise<MapGraph | undefined>>>();

  constructor(
    private readonly inputs: DashboardInputs,
    private readonly preview: Preview | undefined,
  ) {}

  /** The dashboard inputs with the working tree's analysis in place of HEAD's (for `?preview=1` source and call trees). */
  code(): DashboardInputs | undefined {
    const r = this.preview?.current().result;
    return r ? { ...this.inputs, facts: r.facts, snapshot: r.snapshot, trees: r.trees, signals: r.signals } : undefined;
  }

  private inputsOf(r: PreviewResult): Parameters<typeof treeData>[0] {
    return { repoRoot: this.inputs.repoRoot, facts: r.facts, snapshot: r.snapshot, signals: r.signals, understanding: r.understanding };
  }

  view(): PreviewView {
    const head = this.inputs.facts.sha;
    if (!this.preview) return { status: "off", updatedAt: null, durationMs: 0, runs: 0, error: null, head, changes: null, tree: null };
    const s = this.preview.current();
    const r = s.result;
    let tree = r ? this.views.get(r) : undefined;
    if (r && !tree) {
      tree = treeData(this.inputsOf(r));
      this.views.set(r, tree);
    }
    return { status: s.status, updatedAt: s.updatedAt, durationMs: s.durationMs, runs: s.runs, error: s.error, head, changes: r?.changes ?? null, tree: tree ?? null };
  }

  canvas(id: string): Promise<MapGraph | undefined> {
    const r = this.preview?.current().result;
    if (!r) return Promise.resolve(undefined);
    const cache = this.canvases.get(r) ?? new Map<string, Promise<MapGraph | undefined>>();
    this.canvases.set(r, cache);
    const hit = cache.get(id) ?? canvasGraph(this.inputsOf(r), id, { filesWhenUnopened: true });
    cache.set(id, hit);
    return hit;
  }
}

/**
 * JSON API over stored analysis (127.0.0.1 only): GET /api/understanding, /api/canvas?id=, /api/calls?entry=&fn=,
 * /api/source?fn=, /api/map; POST /api/open?id= runs the Open pass, POST /api/ask streams an answer (Build 5); /api/preview (Build 7), /api/timelapses and /api/timelapse?from=&to= (Build 9). Only Open writes.
 */
function apiPlugin(inputs: DashboardInputs, preview: Preview | undefined): Plugin {
  const map = buildMap(inputs);
  const trees = new Map(inputs.trees.map((t) => [t.entryPoint.id, t]));
  const state = new TreeState(inputs);
  const previewApi = new PreviewApi(inputs, preview);
  return {
    name: "catchup-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        const param = (name: string): string => url.searchParams.get(name) ?? "";
        if (url.pathname === "/api/ask") {
          if (req.method !== "POST") return send(res, 405, { error: "use POST" });
          void streamAsk(inputs, state, preview, req, res);
          return;
        }
        if (url.pathname === "/api/open") {
          if (req.method !== "POST") return send(res, 405, { error: "use POST" });
          state.open(param("id")).then(
            (data) => send(res, 200, data),
            (e: unknown) => send(res, 500, { error: errorText(e) }),
          );
          return;
        }
        if (req.method !== "GET") return send(res, 405, { error: "read-only" });
        if (url.pathname === "/api/understanding") return reply(res, Promise.resolve(state.data()), "no understanding yet; run: catchup understand <path>");
        if (url.pathname === "/api/preview") return send(res, 200, previewApi.view());
        if (url.pathname === "/api/timelapses") return send(res, 200, listTimelapses(inputs.repoRoot));
        if (url.pathname === "/api/timelapse") return reply(res, Promise.resolve(loadTimelapse<TimelapseView>(inputs.repoRoot, param("from"), param("to"))), "no such timelapse; run: catchup timelapse <path>");
        if (url.pathname === "/api/preview/canvas") return reply(res, previewApi.canvas(param("id")), "no preview canvas for this node");
        if (url.pathname === "/api/canvas") return reply(res, state.canvas(param("id")), "no canvas for this node");
        if (url.pathname === "/api/map") return reply(res, map, "no map");
        // From the Preview tab, source and call trees come from the working tree.
        const code = (param("preview") && previewApi.code()) || inputs;
        if (url.pathname === "/api/calls") {
          const fn = param("fn");
          const entry = param("entry");
          if (fn) {
            const view = callsOf(code, fn, entry || undefined);
            return view ? send(res, 200, view) : send(res, 404, { error: "no call tree reaches this function" });
          }
          const tree = code === inputs ? trees.get(entry) : code.trees.find((t) => t.entryPoint.id === entry);
          return tree ? send(res, 200, treeView(tree, code.facts, code.snapshot)) : send(res, 404, { error: "no such entry point" });
        }
        if (url.pathname === "/api/source") {
          const source = sourceOf(code, param("fn"));
          return source ? send(res, 200, source) : send(res, 404, { error: "no such function" });
        }
        send(res, 404, { error: "unknown endpoint" });
      });
    },
  };
}

export type DashboardOptions = { port?: number; /** Watch the working tree for the live preview (Build 7). */ preview?: boolean };

/** Starts the dashboard on localhost only; nothing is written to the repo except by the Open pass. */
export async function startDashboard(inputs: DashboardInputs, options: DashboardOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = options.port ?? 5173;
  const preview =
    options.preview && inputs.understanding ? new Preview({ repoRoot: inputs.repoRoot, head: { understanding: inputs.understanding, facts: inputs.facts } }) : undefined;
  preview?.start();
  const server = await createServer({
    root: UI_ROOT,
    configFile: false,
    plugins: [react(), apiPlugin(inputs, preview)],
    // Saves in the analyzed repo must not reload the dashboard itself.
    server: { port, host: "127.0.0.1", strictPort: false, watch: { ignored: [`${inputs.repoRoot}/**`] } },
    logLevel: "warn",
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`;
  return {
    url,
    close: async () => {
      await preview?.stop();
      await server.close();
    },
  };
}
