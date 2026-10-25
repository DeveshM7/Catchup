# Catchup — Architecture

_The technical design. If code and this file disagree, fix one of them in the same change._

## Core principle

**Code decides what exists and what changed. Claude decides what matters and how to say it. Code checks Claude against the facts.** (D1, refined by D36)

- Facts, call trees, signals, IDs and diffs are computed deterministically from source code and git.
- Claude (via the Droid SDK, or the Anthropic API with `CATCHUP_PROVIDER=anthropic`, D51) explores the repo as a **read-only agent** and decides importance, grouping, depth, names and text. Every answer is structured JSON validated against a schema and against the facts.
- Nothing Claude writes may reference a function, file or commit that doesn't exist; Claude never makes IDs.

## Pipeline

```
repo at commit X
  │
  ├─ 1. Extract (language-specific)   → facts       files, functions, imports, calls (incl. links, renders, events, messages), entry points
  ├─ 2. Structure (deterministic)     → components (D19) + edges + external systems
  ├─ 3. Behavior (deterministic)      → call trees per entry point, joined across client → server links
  ├─ 4. Signals (deterministic)       → per function/file: flows using it, systems, fan-in, churn, README, exported
  ├─ 5. Digests (deterministic)       → readable markdown the agent starts from
  ├─ 6. Understand (Claude agent)     → understanding tree: parts + journeys at every level (D37)
  ├─ 7. Validate (deterministic)      → reject / one retry / fail loudly
  └─ 8. Store                         → keyed by commit SHA
                                         │
  changes: diff(tree at A, tree at B) → change set → captions (Claude) → preview / timelapse
```

## 1. Extract (the only language-specific step)

TypeScript/JavaScript (D39). Imports via dependency-cruiser; functions, calls and entry points via the TypeScript compiler API (`ts.createProgram` + type checker). Parsing only: old commits never need to build or install. Rules: D20 (call resolution), D22 (function values), D29 (package values), D33 (handlers and AI tools).

```ts
type Facts = {
  sha: string;
  files: { path: string; lang: string; loc: number; side?: "client" | "server" | "shared" }[];
  functions: { id: string; file: string; name: string; startLine: number; endLine: number; hash: string; exported?: boolean }[];
  imports: { from: string; to: string }[];          // file → file, or file → "pkg:<name>"
  calls: { from: string; to: string | null; line: number; kind: "direct" | "dynamic" | "external" | "callback"; target?: string; callee: string;
           conditional?: boolean; parallel?: boolean; onError?: boolean; oneOf?: boolean; passed?: boolean; tool?: boolean;
           render?: boolean;      // JSX: `from` renders component `to`
           event?: string;        // `to` handles this UI event (`onSubmit`)
           remote?: string;       // a request from client code: the entry point id of the route or server action `to` belongs to
           message?: string }[];  // the server sends `{ type: message }`; `to` is the client function that handles it
  entryPoints: { id: string; kind: EntryKind; label: string; handler: string; file: string }[];
};
type EntryKind = "http" | "page" | "ui" | "action" | "cli" | "library" | "main" | "event" | "queue" | "cron";
```

- Function ID: `<file path>#<qualified name>`. `hash` = hash of the normalized body (D18). Closures get names where they act as entry points or handlers (D42): `get:/x` (`app.get("/x", fn)`), `command:build`, `onSubmit:form` (inline JSX handler), the variable of `useCallback`/`forwardRef`/`new X({…})`; bin files and app roots get a `(module)` unit for their top-level code.
- Links, renders and messages are flags on calls (D43), so one call graph carries them and trees walk them like any call.
- `kind: "dynamic"` = target only known at runtime. Never guessed; the flow is marked **partial**.

### Entry points (TS/JS)

| Kind | Pattern | Status |
| --- | --- | --- |
| `http` | Next.js `app/**/route.ts` exports, `pages/api/**`; `app/router.get/post(path, handler)` (Express/Fastify-style) | built |
| `page` | Next.js `app/**/page.tsx` / `layout.tsx` default export, `pages/**` (non-API); SPA root `createRoot(…).render(<App/>)` | built |
| `ui` | JSX event props (`onSubmit`, `onClick`, …) whose handler reaches a request to us or an outside system; label `<Component> <event>` (+ handler name when two collide) | built |
| `action` | Next.js server actions (exports of `"use server"` files) | built |
| `cli` | `bin` in package.json (dist → src mapped); `.command(name)….action(fn)` chains (commander, cac) | built |
| `library` | functions exported from package.json `exports`/`main`/`module` entry files (following re-exports) | built |
| `main` | fallback: top-level functions nothing calls | built |
| `event`/`queue`/`cron` | `.on('<event>', fn)`, consumers, `cron.schedule`, `vercel.json` crons | later, as repos need them |

### Client side (Build 1, D39, D43)

- **File side:** roots are `"use client"` files and app roots (client) and routes, server actions, pages and layouts (server); sides spread along imports. Server code stops at `"use client"` files (importing one renders it in the browser); client code stops at `"use server"` files (importing one makes a request). Reached from both = shared.
- **Client → server links** (`remote` calls), from files that aren't server-only:
  - a written URL (string or template, `${}` matching a dynamic segment, base and query dropped) matching a route path. Method from `method:` or a bare `fetch(url)` = GET; otherwise every method at that path, flagged `oneOf`. Comparisons (`=== "/api"`, `startsWith`) and route definitions (`app.post("/x", fn)`) aren't requests.
  - a package told our URL (`useChat({ transport: new DefaultChatTransport({ api: "/api/chat" }) })`, `useSWR("/api/x")`): a request-named function it hands out (`sendMessage`, `mutate`, …) links to those routes, whether taken from that call (`const { sendMessage } = useChat(…)`) or received as a prop typed with that package's type (`send: UseChatHelpers["sendMessage"]`). A send function (`send…`, `submit…`, `append…`, `complete…`, `upload…`) links only to the POST routes when there are any (D47).
  - a call from client code to a server action.
- **Renders:** `<Foo …/>` where `Foo` resolves to one of our components (through `memo`/`forwardRef`) → call with `render`.
- **Events:** `<form onSubmit={handler}>` → call with `event` (passed, conditional).
- **Messages:** `{ type: "data-x" }` given to a send-like call (`write`, `send`, `emit`, `enqueue`, …) in server code → each client/shared function that checks `.type === "data-x"` or `case "data-x"` on `.type`.

## 2. Structure (deterministic)

- Components (D19): workspace packages, else depth-1 folders (`src/` transparent), split big ones, merge tiny ones, cap 25. Component ID = path. These are no longer what the user sees as "parts": they're a stable fallback and an input to the agent (D37).
- Edges: file imports rolled up to component → component, weighted by count.
- External systems from imported packages via a lookup table (`packages/analyzer/src/externals.ts`, D29): services (databases, APIs, AI models) and tools (compilers, bundlers, minifiers a build tool drives: esbuild, Rollup, the TypeScript compiler, …), shown alike and labelled `tool` (D53).

## 3. Behavior (call trees)

For each entry point: start at its handler, resolve each call with the type checker, recurse; stop at packages (record the system) and at limits (depth 12, 300 functions; D52). Order, conditionals, parallel, `catch`, tools (D33) are recorded. Scoring (D21): important / normal / noise; noise is low priority, never deleted.

**Worker threads (D52):** `new Worker(<path>)` from `worker_threads`, where a string written in the argument names one of our files (relative to the caller, any source extension), is a passed call to that file's `(module)` unit; such files get one like bins do. `new X()` on our class without a constructor calls the nearest base constructor of ours, or nothing (not a runtime-only call).

**Journeys across the boundary (Build 1, D43):** `remote` calls point at the route handler, so a client tree continues into the server's tree, and `message` calls continue back into the browser: UI → hook → route → model → tools → artifact writers → client handlers. A UI event handler met inside another tree is shown but not expanded (`stop: "event"`): it has its own `ui:` entry point. The client function that receives a message is shown but not expanded either (`stop: "message"`, D46): the journey ends where the browser gets it. Calls reached by a request, a message or as an AI tool are always important.

**Flow families (D32):** entry points whose trees share ≥ 60 % of their functions form a family; families are ranked. Pages and layouts are screens, not journeys, and are left out (D43). A signal for picking main journeys, not the final choice.

## 4. Signals (deterministic, Build 1, D44)

Per function and file, computed by `computeSignals` and saved by `catchup init` in `signals/<sha>.json`:

| Signal | Meaning |
| --- | --- |
| `flows` | how many entry-point trees reach it |
| `systems` | outside systems it calls directly (file: union of its functions) |
| `fanIn` | distinct calling functions (function); distinct importing files (file) |
| `churn`, `lastChanged` | files only: commits touching the file up to the analyzed commit, date of the newest (`git log --no-merges --relative`, no rename following yet) |
| `readme` | path or file name (file), or a name of ≥ 4 characters (function), appears in the README |
| `exported`, `loc`, `side` | from facts (a file is exported if any of its functions is) |

Plus per family: score, members, systems. Signals rank; they never hide anything.

## 5. Digests (deterministic, Build 2)

Facts JSON is too big to read. Before the agent runs, code writes markdown into `.catchup/digest/<sha>/` (`buildDigest`, D46): `repo.md` (README excerpt, package.json, folder tree with file counts, D19 components, systems), `entries.md` (every entry point grouped by flow family, best first, with handler, size, systems), `hot.md` (top functions/files by signals with reasons), `files.md` (every source file with lines, functions, side, flows), and one `flow-<slug>-<hash>.md` per main-journey candidate (top 6 family representatives: rendered tree + key snippets). Rendered trees fold repeated siblings and put a parent's calls to one outside system on one line. The pass prompts carry the digests they need inline (fewer tool calls); the rest are listed for the agent to Read.

## 6. Understand (Claude agent, Build 2)

A Droid session per pass, model `claude-sonnet-5-5` (D23), cwd = the repo, **read-only**: the permission handler allows only Read / Grep / Glob / LS inside the repo and the digest folder, and denies everything else (D36). Output is structured JSON (Zod). Passes:

| Pass | When | Claude returns |
| --- | --- | --- |
| Survey | first run | one-sentence summary; top parts (2–7), each a set of folders/files, covering every in-scope file; 1–3 main journeys (chosen entry points, chained by links); one line per other flow |
| Parts | first run, one per top part (parallel) | its children (or "leaf"), short + long text each |
| Journeys | first run, one per main journey (parallel) | 3–7 steps: text, kind (`main`/`check`/`error`/`branch`), cited function IDs, parts it runs through, whether it's worth opening |
| Open | first time a user opens a node | that node's children, same rules |
| Extras | first run, end of Build 2 | glossary of key ideas, start-here files, "where to change X", surprises (each cited) |

Every pass has caps (tool calls, wall time) and logs calls, tokens and time (D38).

**Runner (`agentRunner`, D45).** One Droid session per pass attempt. Three locks: every non-read tool is disabled in the session (and the run refuses to start if `listTools` shows another one enabled), the permission handler allows only read tools on paths inside the repo (no `.env*` files, no patterns leaving the repo), and every streamed tool call is checked again: a forbidden one interrupts the run. Caps: 20 tool calls and 2 minutes by default (`--max-calls`); at a cap the run is interrupted and asked once to answer without tools. Each attempt adds an entry to `runs/<time>.json` (tool calls with their targets, tokens, time, outcome).

**Provider (D51).** `CATCHUP_PROVIDER=droid` (default, `FACTORY_API_KEY`) or `anthropic` (`ANTHROPIC_API_KEY`). The Anthropic path (`agent/src/anthropic.ts`) plugs into the same `Runner` / `AgentSession` contracts: a Messages API loop whose only tools are our own Read / LS / Glob / Grep (they skip `node_modules`, `.git` and `.env*`), each use passing the same permission handler before it runs; structured output via `output_config.format` (JSON schema with constraints the API rejects removed; Zod still checks them); the conversation carries over for the "answer now" turn. Locks, caps, retries and run logs are unchanged.

**Carry forward.** Each pass's basis is the hash of its prompt; the stored tree for the commit keeps it on the nodes it wrote (`basis`, and `childrenBasis` on the parent). Same prompt → the nodes and everything opened under them are copied, 0 calls; nodes are written with a fixed key order and sorted ids, so the file is byte-identical. Finished stages are saved as they complete, so a failed pass doesn't lose the others.

### The understanding tree (D37)

```ts
type Node = {
  id: string;                       // made by code: `<kind>:<anchor key>`
  kind: "system" | "part" | "journey" | "step";
  title: string;
  short: string;                    // ≤ 12 words
  long: string;                     // ≤ 60 words
  anchor: { files: string[]; functions: string[] };   // parts: files only; journeys/steps: cited functions + their files
  parts?: string[];                 // journeys and steps: top parts they run through (computed)
  systems?: string[];               // computed from the call tree, never by Claude
  stepKind?: "main" | "check" | "error" | "branch";
  entry?: string;                   // journeys: the entry point
  children: string[] | "unopened" | "leaf";
  depth: number;                    // Claude-written level (top parts and journeys = 1; systems = 0)
  basis: string;                    // hash of the prompt it was written from (carry forward, D4)
  childrenBasis?: string;           // hash of the prompt that wrote its children
};
type Understanding = { sha; model; summary; parts: string[]; journeys: string[]; systems: string[];
  otherFlows: { family; entry; label; members; line }[]; nodes: Record<string, Node>;
  extras?: { glossary; startHere; changes; surprises; basis }; basis: string };
```

**IDs and consistency.** Parts: `part:` + the anchor's common folder (or its most central file when folders mix), with a numeric suffix on collision. Steps: `<journey id>#<hash of cited functions>` (as in D23). Across commits (Build 6) a node is matched to the previous tree by anchor overlap; matched + unchanged inputs → same ID and text, no Claude call.

## 7. Validate

Checked before anything is stored; one retry with the problems listed; then fail loudly.

- Every cited file / function / entry point exists; step functions are in that journey's tree (sub-steps: in the step's subtrees). Journeys can't be pages.
- A child's anchor lies inside its parent's; children of a part split its files exactly. Claude gives folders or files; each file goes to the child with the most specific path that holds it, and the validator lists files left over, paths given twice and children left empty. Paths that match no source file (tests, styles) are ignored (D47).
- Limits: 2–7 top parts and children, 1–3 journeys, 3–7 steps (2–7 sub-steps); ≤ 5 Claude-written levels; nodes with < 3 files/functions are leaves.
- Main steps follow the call-tree order (each step's first new function runs no earlier than the previous step's); the first step includes the entry handler; key functions are covered by some step: the handler, AI tools, requests to the server (the requests one function makes form a group: any one is enough, D47) and the browser functions that receive messages.
- One line for each of the top 20 other flow families, no more, no less.
- Extras: every cite is a file path or function ID.
- Word caps per field, with slack (D34): title 5 (≤ 8), short 12 (≤ 15), long 60 (≤ 75), summary 25 (≤ 32).
- IDs are made by code only (Claude never returns one), so a previous ID can only come back with its unchanged node.

## 8. Storage

```
.catchup/                      (not committed, D25)
  facts/<sha>.json             deterministic facts
  snapshots/<sha>.json         components + edges + externals
  signals/<sha>.json           signals (Build 1)
  digest/<sha>/*.md            what the agent reads first (Build 2)
  understanding/<sha>.json     the validated tree (Build 2; replaces explained/)
  runs/<time>.json             calls, tokens, time per run (D38)
  changes/<from>..<to>.json    change sets + captions (Part 3)
  layout.json                  union layout positions (Part 3)
```

`explained/<sha>.json` (D23/D34) is still written by `catchup explain`; the dashboard reads only the understanding tree (D48).

## Rendering (Build 3, D48)

- **Claude never draws.** Our React code renders stored JSON: HTML boxes over SVG edges (D28), Archify-like light style, color per top part, dashed = outside system / only sometimes.
- **Home** (D31): summary, the top parts diagram, each journey's main path (branches and error paths as a "+N" link; long text for the first journey only), 2 start-here files. Under a minute to read.
- **Architecture:** one canvas per part, laid out with elkjs: the top parts (`root`), a part's children, or a leaf part's files, plus the outside systems their files call. Links are weighted by the calls and imports that cross; each box's 3 strongest are drawn. Positions depend only on node IDs and edges, so the same tree always draws the same picture.
- **Flows:** a journey's (or step's) children on a grid: one lane (row) per top part, outside systems in the last row (`flowLayout`, pure, D49). The main path stays in its column while it moves down to later lanes and takes the next column otherwise; branch and error steps are side paths hanging off the main step before them (dashed), never joined back into the line.
- **Known limit:** systems are per function, so a step that cites a big handler shows every system the handler calls (ai-chatbot: the check step on `POST` shows the AI model).
- **Click a box = select it** (side panel + linked highlighting). **▸, double-click or the panel's Open button = open it**; an `unopened` node runs the Open pass first (one at a time, a progress line shows). Breadcrumbs show the path; the route lives in the URL hash.
- **Linked highlighting** goes through files and systems: a selected step lights the parts, files and systems holding its code; a selected part lights the steps whose code lies in it. Works across both tabs and Home.
- **Side panel:** title, text (by familiarity), Open, systems, parts it runs through, steps, code links; a part's panel lists all its files grouped by sub-part, each unfolding to its functions (any function: part → file → function = 3 clicks from Home). Bottom level: a function's call subtree (in its journey's tree) and its source. Back returns through the panel's history. A search box finds any function or file. Ask comes in Part 2.
- **Familiarity toggle (D40):** new = long text, start at Home, hide error steps; familiar = short text, checks folded into one line; expert = code names (a part's folders when no sibling shares them, else its busiest file + a count, D50; a step's functions), no Claude text, error paths shown, start at Architecture. Saved in the browser.
- **Full map** (D19 folder groups) stays as a tab.
- JSON API, `127.0.0.1` only: `GET /api/understanding` (the tree as `TreeData`), `/api/canvas?id=` (`root` or a part id → laid-out graph), `/api/calls?entry=&fn=` (call tree or a function's subtree), `/api/source?fn=`, `/api/map`; `POST /api/open?id=` runs the Open pass and returns the new tree. Nothing else writes.
## Ask (Part 2, Build 5)

- Read-only Droid session (same permission handler as Understand). Starting brief: the question, the selected node (its anchor, parents, children, text), its digest.
- The answer cites node IDs and function/file IDs; citations are checked before showing; the UI highlights cited nodes and animates a cited journey's path.

## Changes (Part 3, Builds 6–9)

**Edit, don't regenerate (D4).** For a new commit: rebuild facts and signals; match old → new functions by ID (renames via `git diff -M`) and body hash; match tree nodes by anchor overlap.

1. Nodes whose anchor and inputs are unchanged: copied exactly (ID, text). No Claude call.
2. Changed nodes: Claude gets the old node + what changed and edits minimally.
3. New code: Claude attaches it to an existing node or proposes a new one (validated).
4. Removed code: nodes shrink; disappear when empty.

- **Change set:** added / changed / removed nodes, plus behavior facts (systems added/removed per journey, steps added/removed, checks removed, new entry points). Computed by code.
- **Preview (Build 7):** chokidar watches the working tree; ~3 s after the last save, rerun 1–4 on the working tree, diff against HEAD's tree, explain only what changed; never stored. Changed nodes sort first.
- **Ask about changes (Build 8):** the brief includes the change set and the commits.
- **Timelapse (Build 9):** ~15 checkpoints between A and B (time-spaced + tags), each analyzed in a `git worktree`, oldest → newest; one layout over the union of all trees (D10); captions cite commits.

## Evaluation

| Test | Measure |
| --- | --- |
| Targets | Hand-written targets (`docs/targets/*.md`): parts, main journey, steps match in substance; scored per build |
| Depth | Expert reaches any function in ≤ 3 clicks; newcomer reads the home screen in < 1 min |
| Citation check | % of claims whose citations resolve (100 %, enforced) |
| Stability | Same commit twice: identical tree. Across commits: unchanged nodes keep ID/text/position |
| Generality | Non-web TS repo gives a sensible tree with no repo-specific rules |
| Planted changes | Small repo with planted changes (new module, renamed interface, new external call, removed check): detected / total |

## Known limits

- Static tracing misses runtime-chosen calls and DI → partial flows. Later: runtime tracing from tests.
- Client → server links only for URLs that are written as strings in the code.
- TS/JS only for now.
