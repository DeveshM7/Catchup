# Catchup — Build Plan

_The live checklist. Tick boxes as you go. Each phase / build has a "done when" check — don't start the next one until it passes._

**Rule:** a working thin slice beats a polished half. Phases 0–5 are the earlier work; the Roadmap (D35) below is what we build now.

## Phase 0 — Setup (≈1 h)

- [x] Decide O1 (storage) and O2 (demo repo) in DECISIONS.md
- [x] Confirm Claude is selectable in Droid (`claude-sonnet-5-5`, D23); booth credits not needed
- [x] Install `droid` CLI, `pnpm add @factory/droid-sdk zod@^3.24.0` (the SDK's structured output expects Zod 3); `FACTORY_API_KEY` in `.env` (never committed)
- [x] Scaffold monorepo (pnpm workspaces) with the packages below; TypeScript strict; vitest
- [x] Clone the demo repo into `fixtures/` (gitignored)

**Done when:** `pnpm test` runs, and a 10-line script calls Droid via the SDK and prints a reply.

## Phase 1 — Extract + Structure (≈3 h)

- [x] `analyzer`: dependency-cruiser → file imports
- [x] `analyzer`: TS compiler API → functions (id, file, lines, body hash)
- [x] Grouping rule → components; roll up edges; external systems lookup table
- [x] Write `facts.json` + `snapshot.json` for HEAD
- [x] Unit tests on a tiny fixture repo with known answers

**Done when:** the demo repo produces 10–25 components that look right to you.

## Phase 2 — Behavior: entry points + call trees (≈4 h) — highest risk, prototype early

- [x] Entry point detection (HTTP routes first)
- [x] Call resolution via the type checker, recursive, with depth limit
- [x] Conditionals, parallel calls, external calls, dynamic calls → partial
- [x] Node scoring (important vs noise)
- [x] Dump one real flow's tree and inspect it by hand

**Done when:** for 3 routes in the demo repo, the call tree matches what you see reading the code.

## Phase 3 — Explain + Validate (≈3 h)

- [x] Zod schemas: Step, Flow, Area, ComponentLabel, Caption
- [x] Droid calls with structured output: labels, flows, areas
- [x] Validator: references exist, coverage, ID preservation; one retry on failure
- [x] Incremental update: carry steps forward, only re-explain changed ones (D4) — tested with a fake Claude; first real use is Phase 4 history

**Done when:** the 3 routes read correctly as 4–8 steps, every step cites real functions, and a second run on the same commit changes nothing.

## Phase 4 — Dashboard (≈5 h) — moved before History (D26)

- [x] React + Vite; Map view with fixed layout (elkjs; drawn as React/SVG since D28)
- [x] Flow overlay + flow view with drill-down (step → functions → call subtree → source)
- [x] Overview with areas (cards + parts diagram); flow view with a lane per component (D28). Parallel calls are not drawn as separate lanes yet
- [x] `catchup open <path>` serves the dashboard locally

**Done when:** `catchup open fixtures/umami` (demo is now `fixtures/ai-chatbot`, D30) shows the map, picking a flow highlights it, and drilling into a step reaches real source.

## Phase 5 — First screen: catch me up — D31; superseded by the roadmap (D35)

- [x] Flow families + ranking (D32), unit-tested
- [x] Mark AI tools: functions passed in `tools: {…}` to an AI SDK call are tool steps in the call tree; follow tools into handler lists and factories (D33)
- [x] Brief job (Claude, `overview`, D34)
- [x] Dashboard first screen: brief, parts diagram, main flows, start-here file
- [ ] ~~Check against the target~~ → moved to Build 2's check (D37 replaces the overview with the understanding tree)

---

# Roadmap (D35)

Three parts, each finished before the next. Every build ends with its "done when" check, tests, typecheck, lint, and a Progress log line. **All nine builds done** (Build 4 closed with known gaps, D55). Build 4 closed early by the user (D55).

## Part 1 — Understand

### Build 1 — Complete facts (deterministic)

- [x] Pick the second test repo: 2–3 small TS CLI tools/libraries with numbers (files, commits, entry kinds); clone to `fixtures/` (gitignored); DECISIONS entry (D41: tsup)
- [x] Entry points: `page` (Next.js pages, SPA root), `action` (server actions), `cli` (`bin`, commander/yargs/cac commands), `library` (package exports), Express-style `http` (D42)
- [x] Entry points: `ui` (JSX event props whose tree reaches a link or a system)
- [x] File side (client / server / shared)
- [x] `renders` edges (JSX → our components) — as `render` calls (D43)
- [x] `links`: client URL calls → route entry points (`fetch`, data packages, `useChat`/transport `api`); method or `oneOf` — as `remote` calls, plus server actions (D43)
- [x] Journeys across the boundary: client tree continues into the linked route's tree
- [x] Shared message types (`type: "data-x"` written ↔ compared) where traceable
- [x] Signals per function/file (`signals/<sha>.json`): flows, systems, fan-in, churn, last changed, README mentions, exported (D44)
- [x] Tiny fixtures with known answers: new `tiny-web` (page → component → `useChat`/SWR/server action → route → message back; D44, instead of growing `tiny-ai`); new `tiny-cli` (bin + commands + library exports)
- [x] `catchup flow` prints journeys across the boundary; smoke tests updated (ai-chatbot, Umami unchanged)

**Done when:** ai-chatbot's "send a message" journey runs UI → hook → `POST /api/chat` → model → tools → artifact writers → `saveDocument`, its client half reaches the data-stream handler, and the second repo's commands / exports are found as entry points, all by code with tests.

### Build 2 — Understanding agent

- [x] Read-only Droid agent runner: permission handler allows Read/Grep/Glob/LS inside the repo + digest folder, denies the rest (tested with a fake session); caps on tool calls and time; run log (calls, tokens, time)
- [x] Digests (`digest/<sha>/*.md`): repo, entries, hot spots, journey candidates
- [x] Tree schema (Zod) + code-made IDs + validator rules (ARCHITECTURE §7), unit-tested with fake answers
- [x] Survey pass: summary, top parts covering every file, main journeys, one line per other flow
- [x] Parts pass and Journeys pass (parallel), short + long text
- [x] Open pass (on demand, saved)
- [x] Carry forward: same inputs → 0 calls, byte-identical tree
- [x] Extras: glossary, start here, where to change X, surprises
- [x] `catchup understand <path>` writes `understanding/<sha>.json`

**Done when:** on ai-chatbot the tree matches Layer 1 and most of Layer 2 of `docs/targets/ai-chatbot.md` in substance (scored item by item), every citation resolves, and a second run makes no Claude calls.

### Build 3 — Zoomable UI

- [x] Home: summary, top parts diagram, main journeys, start here
- [x] Canvas per node (children laid out by elkjs), breadcrumbs, open-on-click (calls the Open pass when needed, shows progress)
- [x] Architecture ↔ Flows linked highlighting
- [x] Side panel: text by familiarity, code links, systems; bottom level = call subtree + source
- [x] Familiarity toggle (D40)
- [x] Replace the old Overview / flow views (keep the full map as an option)

**Done when:** in headless Chrome on ai-chatbot, the home screen reads in under a minute, any function is ≤ 3 clicks away, the expert setting shows no prose, and screenshots look clean.

### Build 4 — Generality check

- [x] Hand-written target for the second repo (`docs/targets/tsup.md`)
- [x] Run Builds 1–3 on it; fix what breaks with general rules only (D52–D54; dashboard on tsup not checked by eye)
- [x] Umami still works (regression): analyzer smoke tests pass; no new Understand run on Umami

**Done when:** the second repo's tree matches its target in substance with no repo-specific rules.

## Part 2 — Ask

### Build 5 — Ask

- [x] Read-only Ask session (shared permission handler), brief from the selected node
- [x] Answers cite nodes/functions/files; citation check; one retry
- [x] General chat + "Ask" on any box; cited nodes highlighted, cited journeys animated
- [x] Show the agent's steps (tool calls) in the UI

**Done when:** five questions per demo repo get correct, cited answers with the right boxes highlighted.

## Part 3 — Changes

### Build 6 — Tree per commit + tree diff

- [x] Analyze a commit in a `git worktree`; renames via `git diff -M`
- [x] Match nodes by anchor overlap; carry forward unchanged nodes (D4); minimal edits for changed ones
- [x] Change set: added / changed / removed nodes + behavior facts (systems, steps, checks, entry points)

**Done when:** on a small repo with planted changes, every planted change is detected and nothing else is reported; unchanged nodes keep ID and text.

### Build 7 — Live preview

- [x] chokidar watcher → working-tree analysis → diff vs HEAD → Preview view, changed first

**Done when:** editing a file updates Preview within ~5 s and shows the right changed boxes.

### Build 8 — Ask about changes

- [x] Brief includes the change set and commits; answers cite them

### Build 9 — Timelapse A → B

- [x] Checkpoints between A and B (time-spaced + tags), oldest → newest
- [x] Union layout (stored in `timelapse/<from>..<to>.json`); captions with commit citations
- [x] Player: play, scrub, added/changed/removed colors

**Done when:** playing ai-chatbot from 2023 to now animates smoothly, nothing unchanged moves or gets renamed, and captions cite real commits.

## Later

- [ ] More languages (Python first); DB tables, config/env, screens as layers; branch-vs-main preview; PR comments; evals in the README
## Packages

```
catchup/
  AGENTS.md          read by Droid on every task
  docs/              SPEC, ARCHITECTURE, DECISIONS, PLAN (this file)
  packages/
    analyzer/        extract + structure + behavior (deterministic)
    history/         checkpoints, worktrees, renames, diffs
    agent/           Droid SDK calls, Zod schemas, validator
    store/           JSON files or SpacetimeDB module
    web/             dashboard
    cli/             catchup init | backfill | watch | open
  fixtures/          demo repos (gitignored) + tiny test repos (committed)
```

## Progress log

_One line per session: date, what got done, what's next, anything surprising._

- 2026-10-24 — Plan written. Next: Phase 0.
- 2026-10-24 — Phase 0 mostly done: pnpm monorepo (6 packages, strict TS 6.0, vitest, eslint), `.gitignore` protects `.env`, `pnpm --filter @catchup/agent hello` gets a Droid reply via the SDK. O1 decided (D15, local JSON); TS pinned to 6.0 (D16). Open: O2 demo repo + clone into `fixtures/`, confirm Claude model selection, booth credits. Surprise: pnpm isn't installed globally; run `corepack enable` once (or prefix commands with `corepack pnpm`).
- 2026-10-24 — O2 decided: Umami (D17), cloned to `fixtures/umami` (6,868 commits, TS since 2022-12-12, 135 Next.js `route.ts` handlers). Still open in Phase 0: confirm Claude model, booth credits. Next: Phase 1 + early Phase 2 prototype on Umami.
- 2026-10-24 — Phase 1 built: `pnpm catchup init fixtures/umami` → 25 components, 1194 files, 2544 functions, 5259 imports, 5 externals (Postgres, ClickHouse, Redis, Kafka, MaxMind) in ~15 s; writes `.catchup/facts|snapshots/<sha>.json`. D18 (hash), D19 (grouping). Surprise: dependency-cruiser resolves tsconfig `paths` from cwd when there's no `baseUrl` (Umami) → fallback to `ts.resolveModuleName`; tiny fixture reproduces it. Phase 2 spike: type checker resolves 17/18 calls in Umami's login route through `@/` and re-exports without node_modules (the miss is the generated Prisma client = external). Awaiting human check of the component list before Phase 2.
- 2026-10-24 — Phase 2 built: `catchup flow <path> ["<label>"] [--all]`. Umami: 203 entry points, 9124 calls (~19 s). Hand-checked login (Postgres, Redis), send (ClickHouse, Kafka, MaxMind, Postgres, Redis), stats (ClickHouse, Postgres, Redis) against the route code: match. D20 (call resolution), D21 (scoring). Caveat: 195/203 flows are partial, mostly because `parseRequest` returns `Promise<any>` (its `error()` can't be resolved) and `runQuery` dispatches on `queries[PRISMA|CLICKHOUSE|KAFKA]` (real dynamic dispatch). O4 still open.
- 2026-10-24 — Gap fix (D22): trace function values (returned closures, callbacks, lookup tables, passed handlers, package ternaries). Umami: partial flows 195 → 0, same systems per flow, 9276 calls, ~22 s. Tiny fixture gained `src/utils/request.ts` + `GET /api/login` cases. Next: Phase 3.
- 2026-10-24 — Phase 3 built: `catchup explain <path> ["<label>" …] [--top N]` → `.catchup/explained/<sha>.json`. Found Droid's default model is GPT, so every call sets `claude-sonnet-5-5` (D23). Umami: login/send/stats read as 8 steps each, all citations valid; second run = 0 Claude calls, byte-identical file. Top 15 (D24) → 17 flows in 4 areas, 19 calls, 153 s; validator rejected 4 first answers, retries fixed all. Next: Phase 4.
- 2026-10-24 — O4 decided: `.catchup/` stays out of git (D25); credits item dropped (not needed).
- 2026-10-24 — Reordered: Dashboard is Phase 4, History + Timelapse Phase 5 (D26). Dashboard built: `catchup open fixtures/umami` → map (30 nodes), areas/flows sidebar, flow highlight with step badges, step → functions → call subtree → source, component/system panel, 186 unexplained routes as call trees. Checked in headless Chrome. Surprise: drawing all 102 import edges made the layout 2.9k px wide; fixed with top-3 edges per component (D27). UI has its own tsconfig (`packages/web/tsconfig.ui.json`, DOM + JSX); `pnpm typecheck` runs both. Next: Phase 5 history.
- 2026-10-24 — Dashboard redesign (D28) after user feedback ("too complex, dry"), Archify as the style reference: light theme, Overview (area cards + 12-node "parts the flows use" diagram), flow as a story (steps left → right in a lane per component, systems lane, step → systems from the call tree), side panel only on click, full map optional. Cytoscape removed; boxes are HTML, edges SVG with elkjs orthogonal routes. 91 tests pass. Next: Phase 5 history.
- 2026-10-24 — Demo repo switched to vercel/ai-chatbot (D30, supersedes D17; `fixtures/ai-chatbot`): 141 files, 6 components, 15 routes, all complete, systems AI model / Postgres / Redis / Blob. Analyzer fixes to get there (D29): values unpacked from package calls, Drizzle driver subpaths, AI SDK + Vercel Blob systems. Umami still 0 partial. New smoke test `aichatbot.test.ts`. All 15 routes explained (6 areas; 2 needed naming because of D24's 2-per-group cap), dashboard checked in headless Chrome. Known issue: a step that cites only the route handler shows all of the handler's systems (e.g. Blob on every upload step). Next: Phase 5 history.
- 2026-10-24 — Step back (D31): current explanations repeat the code and miss the app's core. Wrote a hand-made target for ai-chatbot (`docs/targets/ai-chatbot.md`, layered: first screen + on click). Scratch test showed code can find the main flow (D32: flow families). New Phase 5 = first screen; History moves to Phase 6, reframed as "what changed since X".
- 2026-10-24 — Phase 5 started: `flowFamilies` (D32) puts ai-chatbot's chat flow first (26 vs ≤ 11) and Umami's collect-events + query-stats families top 2 (asserted in the smoke tests). D33: tools traced through `handlers.find(…)` and factory configs, marked `tool`; ai-chatbot chat tree now reaches the artifact writers + `saveDocument` (39 → 50 functions), Umami unchanged. New fixture `fixtures/tiny-ai`. 99 tests pass. Next: brief job.
- 2026-10-24 — `overview` job (D34) + "Catch up" first screen (now the dashboard home; old Overview = "All flows"). ai-chatbot: one sentence, 4 parts + 3 systems, chat flow in 5 steps reaching the artifact writers, start at `app/(chat)/api/chat/route.ts`; code behind each step one click away. First real run failed validation on a 19-word step (limit 18) → caps now have slack. Second run: 0 Claude calls, byte-identical. 104 tests pass. Open: Umami overview not generated yet (families asserted in tests only); parts diagram has 12 arrows and reads busy; dashboard isn't usable at phone width (sidebar, pre-existing).
- 2026-10-25 — Roadmap (D35): three parts — Understand (Builds 1–4), Ask (5), Changes (6–9). Claude becomes a read-only agent that decides importance and grouping while code decides what exists and makes IDs (D36); one understanding tree with two linked views and code-anchored nodes (D37); deeper levels written on first open (D38); TS/JS, end-to-end client + server, second test repo = a small TS CLI/library (D39); familiarity toggle (D40). SPEC and ARCHITECTURE rewritten. Next: Build 1.
- 2026-10-25 — Build 1 done (D41–D44). Second repo tsup: 5 entries (`$ tsup`, `$ tsup-node`, `command [...files]`, `build()`, `defineConfig()`). ai-chatbot: 43 entries (15 http, 7 actions, pages/layouts, 14 ui); the "send a message" journey runs `PureMultimodalInput onSubmit` → `POST /api/chat` (via `useChat`'s transport URL) → tools → artifact writers → `saveDocument` → back to `DataStreamHandler` and `textArtifact.onStreamPart` by `data-*` messages; its family (UI send, suggestions, reading level, the route) ranks first, 48 vs 18. Signals saved by `catchup init`. New fixture `tiny-web`; 128 tests, typecheck, lint pass; Umami smoke unchanged. Known limits in D43 (request-name heuristic, context/props not followed). Next: Build 2.
- 2026-10-25 — Build 2 done (D45–D47). `catchup understand <path> [--max-calls N] [--open "<node id>"]` writes `understanding/<sha>.json` + a run log. ai-chatbot: 13 Claude calls (2 retries fixed by the validator), 2 tool calls, ~80 s; second run 0 calls, byte-identical. Scored against the target: summary, 6 parts by role (Chat interface, Chat API, AI and tools, Artifacts, Auth, Database), send journey runs submit → checks → save chat + title → stream → tools → client handlers → save reply (deletes as a branch), 2 more journeys, 18 other flows, 7 key ideas, start here = `route.ts`, 6 changes; surprises found 1 of 4 target ones (image artifact client-only). Misses: glossary says guest and regular limits differ (they are equal); resume half-wired and tool approval without a customer not found. Fixes after the first real run were general (D47). 151 tests, typecheck, lint pass. Next: Build 3.
- 2026-10-25 — Build 3 done (D48). `catchup open <path>` shows the understanding tree: Home (summary, parts diagram, journeys' main paths, start here), Architecture canvases per part (down to files), Flows lanes per journey/step, side panel down to call subtree + source, familiarity toggle, search, Full map kept; old Overview/flow/first-screen views removed. Checked in headless Chrome on ai-chatbot: home ≈ 240 words + diagram (under a minute); a function in the 83rd file of the biggest part reached in 3 clicks (part → file → function), all 720 functions sit in a top part; expert screens show no Claude text (only system names); opening an unopened part from the UI ran the Open pass (~10 s) with a progress line. 157 tests, typecheck, lint pass. Next: Build 4.
- 2026-10-25 — Flows layout fix (D49): main path packed into columns, branch/error steps hang off the step before them, chips don't break. ai-chatbot send journey: 3 columns instead of 7. 158 tests, typecheck, lint pass.
- 2026-10-25 — Expert names fix (D50): sibling parts carved from one folder all showed the same folder name (`components/chat/`, `components/, hooks/`); now a part keeps its folder name only if it owns it among its siblings, else its busiest file + count. ai-chatbot: every canvas has distinct names. 159 tests, typecheck, lint pass.
- 2026-10-25 — Provider switch (D51): `CATCHUP_PROVIDER=anthropic` reaches Claude through the Anthropic API instead of Droid (`agent/src/anthropic.ts`: structured runner + read-only agent session with our own Read/LS/Glob/Grep, same permission handler, caps and run log). Tested with a fake API (8 tests); not yet run against the live API. 167 tests, typecheck, lint pass.
- 2026-10-25 — Build 4 started: hand-written target `docs/targets/tsup.md` (CLI → config → esbuild per format → output plugins → dist/, dts in a worker; 5 verified surprises). Analyzer today finds all 5 entry points but: the bin journey stops at depth 8, no outside tools (esbuild, Rollup, tsc), the output plugins' `renderChunk` methods and the dts worker are invisible, every flow is partial. Gaps listed in the target. Next: general fixes, then `catchup understand` on tsup.
- 2026-10-25 — Build 4 analyzer fixes (D52, D53): depth 12, worker threads linked to their file's top-level code, `new` on a class without a constructor isn't runtime-only, TypeScript compiler calls kept, tools (esbuild, Rollup, tsc, …) shown next to services. tsup bin journey 53 → 115 functions with esbuild, the dts worker and tsc; ai-chatbot journeys and Umami unchanged. `tiny-cli` gained a worker file. 169 tests, typecheck, lint pass. Next: `catchup understand` on tsup.
- 2026-10-25 — First live Understand run through the Anthropic API (D51) on tsup: 10 Claude calls (1 retry), 0 tool calls, 53 s, ~69k tokens; second run 0 calls, byte-identical. Scored against `docs/targets/tsup.md`: summary ✓; parts by role ✓ (CLI, build engine, esbuild integration, plugins, declarations, helpers, tooling) but the declarations part holds only `ts-resolve.ts` while `rollup.ts`/`tsc.ts`/`api-extractor.ts` sit in "Build engine"; main journey ✓ (command → settings check → esbuild → output plugins → dts branch → watch branch; the plugins step is covered from the factories, so the renderChunk limit didn't hurt); second journey `build()` repeats the first (same flow family); glossary partial (no config file, externals, dts vs experimentalDts); surprises 0 of 5 (agent read no code). Next: journeys from different families, deterministic surprise hints (unused exports), push the extras pass to read code.
- 2026-10-25 — D54 (journeys from different families with ≥ 3 functions, lenient step order, possibly-unused exports in `hot.md`, extras told to read code). tsup live run: 9 calls, no retries, 35 s. Against the target: summary ✓, 6 parts by role ✓ (declarations part now holds `rollup.ts`/`tsc.ts`/`api-extractor.ts`/`ts-resolve.ts`), one main journey ✓ (command → options check → esbuild → output plugins → dts branch → watch branch), defineConfig as an other flow ✓, start-here ✓ (`index.ts`, `esbuild/index.ts`, `cli-main.ts`, `plugin.ts`), changes ✓; glossary partial (no config file / externals); surprises 2 of 5 (deprecation; 3 of 4 dead exports, hedged), with 1 tool call in the whole run; `run.ts` described as "Run after build" though nothing calls it. Next: make the extras pass actually read code, check the dashboard on tsup and Umami.
- 2026-10-25 — Build 4 closed by user choice (D55) with known gaps: surprises 2 of 5 on tsup (the extras agent barely reads code), glossary misses config files and externals, dashboard on tsup and Umami not checked by eye. Next: Build 5 (Ask).
- 2026-10-25 — Build 5 built (D56): `agent/src/ask.ts` (map + selected box + last 3 turns → read-only agent → `{answer, cites}`; cites must be box ids, function ids or files, decoration stripped; one retry), live tool steps via `agentRunner`'s `onTool`, `POST /api/ask` streaming NDJSON, `catchup ask <path> "<q>" [--node id]`, Ask panel (chat, "Ask about this" on any box, cite chips, answer lights its files/systems/boxes, cited journey steps pulse in order). Live: two CLI/curl answers on ai-chatbot correct and grounded (rate limits: 7 tool calls, 22 s, got "limits identical" right; createDocument hand-off: 3 tool calls). Headless Chrome caught a crash (an effect returning `scrollIntoView`'s Promise) and Claude copying `[id]` brackets into cites; both fixed. Then the Anthropic credit ran out mid-check, so the "five questions with the right boxes lit" check is not done. 179 tests, typecheck, lint pass.
- 2026-10-25 — Build 5 done. Back on Droid (provider switch, D51). Run failures (API errors, billing) are now retried as-is and reported as `RunError`, not as validation failures. Check in headless Chrome on ai-chatbot, five questions through the Ask panel: artifact streaming to the side panel, resuming a dropped stream (found it's a stub: `GET …/stream` returns 204), where the reply is saved and what happens on failure (on the Flows view: "Save the reply" pulses), who can read a private chat (owner only), uploads (Vercel Blob, JPEG/PNG ≤ 5 MB). All five correct against `docs/targets/ai-chatbot.md`, 11–23 s, 2–8 files read each, every cite resolved, the right boxes lit. Fixes from the check: the canvas shrinks beside the Ask panel; cited files light the systems they call (upload → Blob storage); file chips show their folder. Next: Build 6.
- 2026-10-25 — Build 6 done (D57). `history`: worktrees, renames, commits, checkpoints. `agent/src/evolve.ts` (tree at B from tree at A, code first) and `changes.ts` (change set). CLI: `init/understand --at <ref> [--from <ref>]`, `diff <from> <to>`. New fixture `fixtures/tiny-changes` (v1 → v2 with four planted changes); test builds a real two-commit repo, analyzes both commits in worktrees, evolves with fake Claude and asserts the exact change set. Live through Droid: v1 tree 4 calls / 38 s, evolve to v2 2 calls / 10 s, all planted changes and nothing else. Bugs found on the way: symlinked repo paths lost every local import (macOS tmp); handler-spanning steps tripped the order rule. 187 tests, typecheck, lint pass. Next: Build 7 (live preview).
- 2026-10-25 — Build 7 done (D58). `web/src/server/preview.ts` (watch → analyze working tree → offline evolve → change set), `/api/preview(+/canvas)`, Preview tab with change count. Offline mode in `evolve` (no Claude). Test: a real watcher on a temp repo sees v2's planted changes saved over v1 within 5 s. Checked in headless Chrome on the planted repo (behavior facts, new route, Redis, marked boxes) and timed on ai-chatbot: 3.2 s from save to updated preview. Next: Build 8 (Ask about changes).
- 2026-10-25 — Build 8 done (D59). Ask takes a change context (change set + commits); commits are citable. Dashboard: asking from the Preview tab is about uncommitted work; `{from,to}` ranges for the timelapse. CLI: `ask --changes <from>..<to>`. Live through Droid on the planted repo: a commit-range question named the removed auth check and cited the commit; a Preview-tab question about an uncommitted edit found the leftover Redis client. Next: Build 9 (timelapse).
- 2026-10-25 — Build 4 gap narrowed (D61): swallowed-error candidates in the facts and `hot.md`. tsup rerun (8 calls): surprises 4, all verified (dead exports, swallowed dts failures, `jsoncParse`, worker error detail). Added a README.
- 2026-10-25 — Build 9 done (D60). `catchup timelapse` (checkpoints → trees evolved or fresh → change sets → cited captions → frames on one union layout), Timelapse tab (play, scrub, step; caption, impact, commit chips, counts, journeys; Ask about the step). ai-chatbot 2023-05 → 2026-07: 15 checkpoints picked from 576 commits, 12 built (3 skipped: one forbidden tool use blocked by the lock, two validation failures), 8 min; 0 unchanged boxes renamed, 42 cited commits all real, box positions identical in every frame (checked in headless Chrome); asking about the last step found the commit that brought Redis (`ad47aa0`). Fixes found on the way: digests inside worktrees (the agent inferred the main repo path from the digest folder), resuming half-written trees, rejections in run logs, zero journeys allowed when an app has only screens. Known limits: frames are drawn small (the union of 28 boxes sets the scale); a tree written fresh across a big rewrite starts new boxes (2023-07, 2025-04, 2026-07 show waves of additions).
