# Catchup — Agent Guide

Catchup computes a repo's architecture and runtime flows from code + git history, has Claude organize and explain them as one zoomable tree (D37), and shows how they changed (timelapse) and what uncommitted changes will do (preview).

## Read before any task

1. `docs/SPEC.md` — what we're building and what's out of scope
2. `docs/ARCHITECTURE.md` — the technical design
3. `docs/DECISIONS.md` — decisions already made (don't reopen them without asking)
4. `docs/PLAN.md` — current build and checklist; work only on the current build (Roadmap, D35)

## Non-negotiable rules

- **Deterministic first.** Facts, call trees, signals, IDs and diffs are computed by code. Never use an LLM to decide what exists or what changed, and never let it make IDs.
- **Claude only via the Droid SDK or the Anthropic SDK** (`CATCHUP_PROVIDER`, default Droid, D51), only with Zod-validated structured output, only for deciding importance, grouping, depth, naming, explaining and Ask (D36).
- **Every Claude reference is validated** against the facts (functions, files, commits). Invalid → one retry → fail loudly.
- **Edit, don't regenerate.** Updates carry the previous snapshot forward; unchanged steps keep identical IDs and text.
- **Claude never draws.** Rendering is our code (elkjs layout + React/SVG, D28) from stored JSON.
- **Claude agents are read-only** (Understand and Ask). Their permission handler must deny writes and non-allowlisted commands.
- Only the extractor is language-specific; everything downstream uses the `Facts` format.

## Working conventions

- TypeScript strict, ESM, pnpm workspaces. No `any`.
- Tests with vitest next to the code. Deterministic packages need unit tests on tiny fixture repos with known answers.
- Never commit `.env` or API keys. `FACTORY_API_KEY` / `ANTHROPIC_API_KEY` come from the environment.
- Keep functions small; deterministic packages must not import the Droid or Anthropic SDK.
- If a change contradicts `docs/`, stop and ask, or update the doc in the same change with a new DECISIONS entry.

## Commands

- Install: `pnpm install`
- Test: `pnpm test`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Run on a repo: `pnpm catchup init <path>` (once the CLI exists)

## When you finish a task

- Run tests and typecheck.
- Tick the box in `docs/PLAN.md` and add a line to its Progress log.
- If you made a design choice, add it to `docs/DECISIONS.md`.
