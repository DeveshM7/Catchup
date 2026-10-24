# Catchup — Architecture

_The technical design. If code and this file disagree, fix one of them in the same commit._

## Core principle

**Code decides what exists and what changed. Claude decides what matters and how to say it. Code checks Claude against the facts.**

- Structure, call trees, IDs and diffs are computed deterministically from source code and git.
- Claude (via the Droid SDK) only groups, ranks, names and explains — always as structured JSON validated against a schema.
- Nothing Claude writes may reference a function, file or commit that doesn't exist.

## Pipeline

```
repo at commit X
  │
  ├─ 1. Extract (language-specific)   → facts.json   files, functions, imports, calls, entry points
  ├─ 2. Structure (deterministic)     → components + component edges + external systems
  ├─ 3. Behavior (deterministic)      → one call tree per entry point, scored
  ├─ 4. Explain (Claude via Droid)    → flows (steps), areas, labels — edits of the previous snapshot
  ├─ 5. Validate (deterministic)      → reject/retry anything that doesn't match the facts
  └─ 6. Store                         → snapshot keyed by commit SHA
                                         │
  history: diff(snapshot N-1, snapshot N) → change set → caption (Claude) → timelapse frame
  preview: diff(last commit snapshot, working tree)    → never stored
```

## 1. Extract (the only language-specific step)

Output is a language-neutral **facts** format, so every later step works for any language.

- **TypeScript first.** Imports via dependency-cruiser; functions, calls and entry points via the TypeScript compiler API (`ts.createProgram` + type checker — the "Go to Definition" engine).
- Later languages add an extractor that emits the same facts (tree-sitter for syntax; Pyright etc. for precise call resolution).
- Cross-language links at boundaries: `fetch('/api/x')` ↔ route `POST /api/x`, queue names, DB tables, OpenAPI/gRPC specs.
- Parsing only — old commits never need to build or install.

```ts
type Facts = {
  sha: string;
  files: { path: string; lang: string; loc: number }[];
  functions: { id: string; file: string; name: string; startLine: number; endLine: number; hash: string }[];
  imports: { from: string; to: string }[];          // file → file, or file → "pkg:<name>"
  calls: { from: string; to: string | null; line: number; kind: "direct" | "dynamic" | "external"; target?: string; conditional?: boolean; parallel?: boolean }[];
  entryPoints: { id: string; kind: "http" | "cli" | "main" | "event" | "queue" | "cron"; label: string; handler: string; file: string }[];
};
```

- Function ID: `<file path>#<qualified name>` (e.g. `src/db/users.ts#findUser`). `hash` = hash of the normalized function body, used to detect changes.
- `kind: "dynamic"` = call target only known at runtime (e.g. `handlers[key]()`, DI). Never guessed.

### Entry point patterns (TypeScript, first pass)

| Kind | Pattern |
| --- | --- |
| HTTP | `app.get/post/put/delete/use(path, handler)` (Express/Fastify-style), `router.*`, Next.js `app/**/route.ts` exports, `pages/api/**` |
| CLI | `bin` in package.json, `program.command(...)` (commander/yargs) |
| Main | `main` in package.json, top-level files with side effects |
| Event/queue | `.on('<event>', handler)`, `.subscribe(...)`, `.process(...)`, consumer registrations |
| Cron | `cron.schedule(...)`, scheduler configs |

Unknown frameworks: Claude may *suggest* entry points; keep only ones found in the code.

## 2. Structure

- **Grouping rule (fixed, same at every commit):** workspace packages in a monorepo; otherwise folders under `src/` at depth 1–2. Merge tiny folders into their parent. Cap ~25 components.
- **Component ID = path** (e.g. `src/auth`). Renames followed with `git diff -M` so IDs carry over.
- **Edges:** file imports rolled up to component → component, weighted by count.
- **External systems:** from imported packages (`pg`, `redis`, `stripe`, `@aws-sdk/*`, `kafkajs`…) via a small lookup table → boxes like "Postgres".

## 3. Behavior (call trees)

For each entry point: start at its handler, resolve each call to its definition with the type checker, recurse. Stop at external packages (record the external system) and at depth/size limits. Record order, conditionals (`if`, early return, `catch`) and parallelism (`Promise.all`, emit/publish).

**Scoring each node (deterministic):**

- Important: crosses a component boundary; touches an external system; writes state; used by many flows.
- Noise: logging, validation helpers, error-only branches, tiny utilities, type guards.

Noise is marked low priority, never deleted. Flows with dynamic calls are marked **partial** with the location.

**Async links:** a publish to queue `X` links to the flow whose entry point consumes `X`.

## 4. Explain (Claude via Droid SDK)

All calls use the Droid TypeScript SDK with structured output (Zod schemas). Model: Claude.

| Job | Input | Output |
| --- | --- | --- |
| Label components | component files + key exports | name + one-line description (new components only) |
| Build flow | scored call tree + snippets of important functions + **previous version of this flow** | 4–8 steps, main vs error paths |
| Group areas | all flows + signals (components touched, externals, user-facing) | 3–7 areas, ranked |
| Caption | change set between two snapshots + commit messages | what changed + design impact, with commit citations |
| Ask | question + clicked context + read-only repo tools | answer with file/commit citations |

```ts
const Step = z.object({
  id: z.string(),                    // stable across commits
  label: z.string(),
  summary: z.string(),
  functions: z.array(z.string()),    // function IDs from facts
  kind: z.enum(["main", "error", "branch"]),
  children: z.array(z.string()).optional(), // level-2 step ids, generated on demand
});
const Flow = z.object({ id: z.string() /* = entry point id */, area: z.string(), steps: z.array(Step), partial: z.boolean() });
```

## 5. Validate

Every Claude output is checked before it's stored:

- Every referenced function/file/commit exists in the facts.
- Every important node (external call, component crossing) is covered by some step.
- Every component and external system appears in at least one flow on the overview, or under "Other".
- Step IDs carried over from the previous snapshot are preserved.

On failure: send the errors back to Claude for one retry; then fail loudly (never silently store).

## 6. Consistency over time (the key rule)

**Claude never rebuilds from scratch after the first snapshot. Each commit is an edit of the previous snapshot.**

1. Rebuild facts for the new commit (deterministic).
2. Map functions old → new by ID, following renames; compare body hashes.
3. Steps whose functions are unchanged: copied exactly (same ID, label, text). No Claude call.
4. Steps whose functions changed: Claude gets the old step + only what changed, and updates minimally.
5. New important functions: Claude attaches them to an existing step or proposes a new one.
6. Removed functions: step shrinks; disappears if empty.

History is processed oldest → newest so each frame edits the one before.

## History and checkpoints

- Sample ~15 checkpoints on the main branch: evenly over time, plus tags/releases. Change between frames covers all commits in between.
- Each checkpoint analyzed in a temporary `git worktree` (simple-git).
- New commits (yours or from `git pull`) append a frame.

## Preview (uncommitted changes)

- chokidar watches the working tree; ~3 s after the last save, rerun extract → structure → behavior on the working tree.
- Diff against the latest commit's snapshot; Claude only explains changed steps.
- Never stored.

## Ask

- Read-only Droid session in the repo. Tools: read files, search, `git log`, `git show`. Permission handler denies every write/execute that isn't on the allowlist.
- Starting brief: the question, the clicked component/flow/step and its functions and files, the change between the frames being viewed, related commits.
- Every citation is checked to exist before the answer is shown.

## Rendering

- **Claude never draws.** It writes JSON; our code renders.
- Layout computed **once over the union of all snapshots** with elkjs, so every component keeps one position forever.
- Cytoscape.js draws the map; the timelapse toggles visibility + color per frame and animates over ~1 s.
- Flow view: left-to-right steps, error paths as dimmed side branches, click to expand.
- Colors come from the deterministic diff, never from Claude.

## Storage

Per repo, under `.catchup/` (or SpacetimeDB — see decision O1):

```
.catchup/
  snapshots/<sha>.json     facts summary + components + edges + flows + areas
  changes/<from>..<to>.json  added/removed/changed + caption + citations
  layout.json              union layout positions
  state.json               checkpoints, last-seen, config
```

## Evaluation

| Test | Measure |
| --- | --- |
| Hand-labeled demo repo | Do the flows/steps match what a person who knows the repo would draw? Precision of steps, coverage of important functions |
| Planted changes | Build a small repo over commits with planted changes (new module, renamed interface, new external call, new error path). Count detected / total |
| Stability | Re-run the same history twice: identical IDs, labels unchanged where code is unchanged |
| Citation check | % of Claude claims whose citations resolve (target 100%, enforced by validator) |
| Comprehension | 2 min with Catchup vs 2 min with the repo/git log, same 5 questions |

## Known limits

- Static tracing misses runtime-chosen calls, DI, some callbacks → flows marked partial. Later: runtime tracing from tests.
- Messy folder layouts → messy components. Later: Claude-suggested regrouping, still validated.
- TypeScript only at first.
