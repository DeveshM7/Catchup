# Catchup — Build Plan

_The live checklist. Tick boxes as you go. Each phase has a "done when" check — don't start the next phase until it passes._

**Rule:** a working thin slice beats a polished half. Phases 1–3 alone make a demo with no AI.

## Phase 0 — Setup (≈1 h)

- [ ] Decide O1 (storage) and O2 (demo repo) in DECISIONS.md
- [ ] Get Factory credits at the booth; confirm Claude is selectable in Droid
- [ ] Install `droid` CLI, `pnpm add @factory/droid-sdk zod@^3.24.0` (the SDK's structured output expects Zod 3); `FACTORY_API_KEY` in `.env` (never committed)
- [ ] Scaffold monorepo (pnpm workspaces) with the packages below; TypeScript strict; vitest
- [ ] Clone the demo repo into `fixtures/` (gitignored)

**Done when:** `pnpm test` runs, and a 10-line script calls Droid via the SDK and prints a reply.

## Phase 1 — Extract + Structure (≈3 h)

- [ ] `analyzer`: dependency-cruiser → file imports
- [ ] `analyzer`: TS compiler API → functions (id, file, lines, body hash)
- [ ] Grouping rule → components; roll up edges; external systems lookup table
- [ ] Write `facts.json` + `snapshot.json` for HEAD
- [ ] Unit tests on a tiny fixture repo with known answers

**Done when:** the demo repo produces 10–25 components that look right to you.

## Phase 2 — Behavior: entry points + call trees (≈4 h) — highest risk, prototype early

- [ ] Entry point detection (HTTP routes first)
- [ ] Call resolution via the type checker, recursive, with depth limit
- [ ] Conditionals, parallel calls, external calls, dynamic calls → partial
- [ ] Node scoring (important vs noise)
- [ ] Dump one real flow's tree and inspect it by hand

**Done when:** for 3 routes in the demo repo, the call tree matches what you see reading the code.

## Phase 3 — Explain + Validate (≈3 h)

- [ ] Zod schemas: Step, Flow, Area, ComponentLabel, Caption
- [ ] Droid calls with structured output: labels, flows, areas
- [ ] Validator: references exist, coverage, ID preservation; one retry on failure
- [ ] Incremental update: carry steps forward, only re-explain changed ones (D4)

**Done when:** the 3 routes read correctly as 4–8 steps, every step cites real functions, and a second run on the same commit changes nothing.

## Phase 4 — History + Timelapse (≈4 h)

- [ ] Sample ~15 checkpoints; analyze each in a `git worktree`; oldest → newest
- [ ] Rename tracking (`git diff -M`)
- [ ] Snapshot diff → change sets; Claude captions with commit citations
- [ ] Union layout (elkjs) → `layout.json`

**Done when:** all checkpoints processed; change sets look right for 3 hand-checked steps.

## Phase 5 — Dashboard (≈5 h)

- [ ] React + Vite + Cytoscape.js; Map view with fixed layout
- [ ] Flow overlay + flow view with drill-down
- [ ] Overview with areas and lanes
- [ ] Timelapse player: play, scrub, colors, captions

**Done when:** pressing play animates the demo repo's history smoothly and nothing jumps.

## Phase 6 — Preview + Ask (≈3 h)

- [ ] chokidar watcher → working-tree analysis → diff vs HEAD snapshot → Preview tab
- [ ] Ask: read-only Droid session, permission handler, starting brief, citation check
- [ ] Show Droid's plan/steps in the UI (Factory criteria: make the agent's work visible)

**Done when:** editing a file updates Preview within ~5 s; clicking a step and asking gives a cited answer.

## Phase 7 — Proof + submission (remaining time)

- [ ] Evals (ARCHITECTURE.md → Evaluation); numbers into the README
- [ ] README: what it does, how Droid is used (Factory requirement), setup, limits
- [ ] Record backup demo video; rehearse the 2-minute demo
- [ ] Submit to tracks: Factory, Anthropic, Microsoft (+ SpacetimeDB if O1 = SpacetimeDB)

## Stretch (only if everything above works)

- [ ] Branch-vs-main preview
- [ ] Python extractor
- [ ] GitHub Action posting a PR comment

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
