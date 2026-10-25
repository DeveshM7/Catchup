# Catchup

**Never lose track of your codebase.** Catchup shows what a codebase does, how it changed, and what your uncommitted
changes are about to do, as architecture and flow diagrams you can zoom from "what is this app" down to a single
function.

Coding agents now change large projects faster than a person can follow. Catchup rebuilds the picture from the code
itself: the parts of the system, the journeys a request takes through them, how both evolved commit by commit, and the
effect of the change you are making right now.

## Features

| View | What it shows |
| --- | --- |
| **Home** | What the app is, its main parts, the main user journeys in a few steps, and where to start reading. |
| **Architecture** | The system → parts → sub-parts → files → functions, with the outside systems each part calls. |
| **Flows** | Each journey (for example "sending a message") step by step, from the user's action through client, server, AI model and databases, down to the call tree and source. |
| **Ask** | A chat with a read-only agent that reads the code and answers with checked citations; the boxes it cites light up. Works on any box, on uncommitted changes and on a range of commits. |
| **Preview** | Uncommitted changes, re-analyzed a few seconds after each save: new entry points, new outside systems, removed checks, and the parts they land in. |
| **Timelapse** | The code's history between two commits as a sequence of frames; boxes keep their place and fade in, change and out, with a caption per step citing the commits responsible. |

A familiarity setting (new / familiar / expert) controls how much explanation appears, so the same tool serves a
newcomer and the person who wrote the code.

## How it works

Catchup separates what code can decide from what needs judgement:

1. **Code decides what exists.** A TypeScript compiler API extractor computes files, functions, imports, calls,
   client → server links and entry points; deterministic passes build call trees, signals (reach, fan-in, churn,
   swallowed errors, early-exit guards) and every identifier. Change sets between commits are computed, never generated.
2. **Claude decides what matters and how to say it.** Read-only Claude agents group the code into parts, choose the main
   journeys and their steps, write the descriptions, answer questions and caption history.
3. **Code checks Claude.** Every answer is structured JSON validated with Zod and against the facts: each cited file,
   function, box and commit must exist. An invalid answer gets one retry with the problems listed, then the run fails
   loudly.
4. **Edit, don't regenerate.** Results are stored per commit. A later commit's tree is evolved from the previous one, so
   unchanged boxes keep their identifiers, text and position.

The pipeline is described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Privacy and security

- **Local first.** Analysis results are written to `<repo>/.catchup/`, which ignores itself in git. The analyzed
  repository is never modified; older commits are read from temporary git worktrees.
- **What leaves your machine.** Only the Claude passes send data to the model provider: the computed digests and the
  source files the agent chooses to read. Preview, Timelapse playback and all navigation make no model calls.
- **Read-only agents.** Agents may only use Read, Grep, Glob and LS inside the repository. Paths are checked after
  resolving symlinks, and `.env` and other secrets files are refused.
- **Local dashboard.** The dashboard listens on `127.0.0.1` only and refuses actions (Ask, Open) requested by other
  websites, so a page you visit cannot spend your credits.
- **Credentials** are read from the environment (`.env`, which is ignored by git) and are never written to disk by
  Catchup.

## Requirements

- Node.js 22.12 or later and pnpm (`corepack enable`)
- git
- One model provider:
  - [Factory Droid](https://factory.ai) (default): `FACTORY_API_KEY`
  - the Anthropic API: `CATCHUP_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`
- Repositories in TypeScript or JavaScript

## Setup

```sh
pnpm install
cp .env.example .env    # then fill in FACTORY_API_KEY, or set CATCHUP_PROVIDER=anthropic and ANTHROPIC_API_KEY
```

`CATCHUP_MODEL` optionally overrides the model (default `claude-sonnet-5-5`).

## Usage

```sh
pnpm catchup init <repo>          # facts, call trees and signals for HEAD (no model calls)
pnpm catchup understand <repo>    # the understanding tree: parts, journeys, steps, descriptions
pnpm catchup open <repo>          # the dashboard on http://127.0.0.1:5173
```

Further commands:

```sh
pnpm catchup flow <repo> ["<entry point>"]                 # list entry points, or print one call tree
pnpm catchup ask <repo> "<question>" [--node <id>] [--changes <from>..<to>]
pnpm catchup understand <repo> --at <ref>                  # the tree at another commit, evolved from an earlier one
pnpm catchup diff <repo> <from> <to>                       # what changed between two commits
pnpm catchup timelapse <repo> [--from <ref>] [--to <ref>] [--count 15]
```

### Example

The demo repository is [vercel/ai-chatbot](https://github.com/vercel/ai-chatbot):

```sh
git clone https://github.com/vercel/ai-chatbot fixtures/ai-chatbot
pnpm catchup init fixtures/ai-chatbot
pnpm catchup understand fixtures/ai-chatbot
pnpm catchup timelapse fixtures/ai-chatbot --count 15
pnpm catchup open fixtures/ai-chatbot
```

Edit a file in `fixtures/ai-chatbot` while the dashboard is open and the **Preview** tab reports what the edit does.

## Project layout

```
packages/
  analyzer/   deterministic analysis: facts, structure, call trees, signals (the only language-specific part)
  history/    git: churn, worktrees, renames, commit ranges, checkpoints
  agent/      Claude passes, Zod schemas, validators, evolve, change sets, Ask, captions
  store/      JSON storage under <repo>/.catchup/
  web/        dashboard server (Vite) and React UI; layouts with elkjs
  cli/        the catchup command
fixtures/     small test repositories with known answers (larger demo repositories are cloned here and ignored)
docs/         specification, architecture, decision log, build plan, hand-written evaluation targets
```

## Development

```sh
pnpm test         # vitest; the tiny fixtures have known answers, model calls are faked
pnpm typecheck
pnpm lint
```

Tests never call a model. Contributors and coding agents should read [`AGENTS.md`](AGENTS.md) first.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md): the product, who it is for, success criteria
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the technical design
- [`docs/DECISIONS.md`](docs/DECISIONS.md): every design decision with its reason and the alternatives considered
- [`docs/PLAN.md`](docs/PLAN.md): the build plan and progress log
- [`docs/targets/`](docs/targets): hand-written evaluation targets for the demo and generality repositories

## Known limits

- TypeScript and JavaScript only; the extractor is the one language-specific component.
- Static analysis misses calls chosen at runtime (dependency injection, plugin hooks), so some flows are partial.
- Client → server links are found only for URLs written as strings in the code.
- Timelapse frames covering a large rewrite start new boxes rather than evolving the old ones.

## License

[MIT](LICENSE)
