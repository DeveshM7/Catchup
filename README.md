# Catchup

Catchup shows what a codebase does, how it changed, and what your uncommitted changes are about to do, as
architecture and flow diagrams you can zoom from "what is this app" down to a single function.

- **Code decides what exists and what changed.** Files, functions, call trees, client ↔ server links, signals, IDs and
  diffs are computed from the source and git history (TypeScript compiler API, dependency-cruiser).
- **Claude decides what matters and how to say it.** Read-only Claude agents (Droid SDK, or the Anthropic API) group
  the code into parts, pick the main journeys, write the text, and answer questions.
- **Code checks Claude.** Every answer is structured JSON, validated against the facts (every cited file, function,
  box and commit must exist), retried once, else rejected.

See `docs/SPEC.md` (what and why), `docs/ARCHITECTURE.md` (how), `docs/DECISIONS.md` (decision log) and
`docs/PLAN.md` (builds and progress).

## Setup

Node ≥ 22.12 and pnpm (`corepack enable`).

```sh
pnpm install
cp .env.example .env   # FACTORY_API_KEY for Droid (default), or CATCHUP_PROVIDER=anthropic + ANTHROPIC_API_KEY
```

## Use it on a repository

```sh
pnpm catchup init <repo>                 # facts, call trees, signals for HEAD (no Claude)
pnpm catchup understand <repo>           # the understanding tree: parts, journeys, steps, notes (Claude)
pnpm catchup open <repo>                 # the dashboard on http://127.0.0.1:5173
```

The dashboard has:

- **Home**: what the app is, its parts, the main journeys in a few steps, where to start reading.
- **Architecture / Flows**: one tree in two views. Click a box to select it (linked highlighting across views),
  ▸ to open it; the deepest level is a function's call tree and source. A familiarity toggle (new / familiar /
  expert) picks how much prose you see.
- **Ask**: a chat with a read-only agent that reads the code and answers with checked citations; the boxes it cites
  light up. "Ask about this" works on any box.
- **Preview**: your uncommitted changes, re-analyzed a few seconds after each save: which journeys now use a new
  system, which checks were removed, which entry points appeared, which parts changed. Ask about them from there.
- **Timelapse**: play the code's history between two commits; boxes keep their place and fade in, change and out,
  with a cited caption per step.

More commands:

```sh
pnpm catchup flow <repo> ["<entry point>"]          # entry points, or one call tree
pnpm catchup ask <repo> "<question>" [--node <id>] [--changes <from>..<to>]
pnpm catchup understand <repo> --at <ref>           # the tree at another commit, evolved from an earlier one
pnpm catchup diff <repo> <from> <to>                # what changed between two commits with trees
pnpm catchup timelapse <repo> [--from <ref>] [--to <ref>] [--count 15]
```

Everything Catchup writes goes to `<repo>/.catchup/` (ignored by git); the analyzed repository is never modified.

## Develop

```sh
pnpm test        # vitest; fixtures with known answers in fixtures/tiny*
pnpm typecheck
pnpm lint
```

Packages: `analyzer` (facts, call trees, signals), `agent` (Claude passes, schemas, validators, evolve, change sets,
Ask, captions), `history` (git: churn, worktrees, renames, checkpoints), `store` (`.catchup/` files), `web`
(dashboard server and React UI), `cli`.
