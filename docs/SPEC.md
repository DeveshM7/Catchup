# Catchup — Product Spec

_Working name. Last updated: 2026-10-24 (Cal Hacks 13.0)._

## One line

Catchup shows how a codebase works, how it got that way, and what your uncommitted changes are about to do to it — computed from the code and git history, explained by Claude.

## The problem

- Coding agents change large projects faster than a person can follow. After a few days you no longer know your own codebase.
- Opening an unfamiliar repo, it's hard to see what the parts are, how a request actually runs through them, and how the design evolved.
- Existing tools show a repo's current state (DeepWiki, Archify) or one PR's diff (unkode, PR Lens). Nothing shows the architecture's history as a timelapse together with a preview of your next change.

## Who it's for

Developers working on large or unfamiliar repos — especially solo developers and students running long Claude Code projects (the named community for the Anthropic track).

## Core use cases

1. **Understand an existing repo.** Clone any repo, run `catchup init`, and see its components, its main runtime flows, and a timelapse of how they evolved.
2. **Review changes before committing.** See what your uncommitted (often agent-written) changes do to the architecture and flows before you commit.
3. **Follow a project over time.** Every commit adds a frame; replay how the system changed and why.
4. **Ask why.** Click any component, flow step or change and ask questions; answers cite files and commits.

## What the user sees

A local web dashboard (`catchup open`):

- **Map** — components as boxes, dependencies as arrows, external systems (Postgres, Stripe, queues) as their own boxes. Same layout across all of history.
- **Flows** — each entry point (e.g. `POST /login`) as 4–8 readable steps, drawn as an animated path across the map. Click a step to expand it; click again to reach the code.
- **Overview** — flows grouped into 3–7 areas (e.g. Auth, Payments, Background jobs); parallel processes shown as lanes.
- **Timelapse** — play or scrub ~15 checkpoints; green = added, amber = changed, red = removed; one caption per step citing commits.
- **Preview** — what the working tree's uncommitted changes do to the map and flows, updated a few seconds after you stop saving.
- **Ask** — questions answered by a read-only agent, with citations.

## Hackathon scope (must ship)

1. Structure: component map for one TypeScript repo, computed from imports.
2. Behavior: entry points + call trees → Claude-grouped flows with drill-down.
3. History: ~15 sampled checkpoints, incremental updates, timelapse.
4. Preview of uncommitted changes.
5. Ask, read-only, with citations.
6. Evals with numbers on screen.

## Out of scope for the hackathon (later)

- Languages beyond TypeScript (design for them now, build later)
- Team / branch / CODEOWNERS scoping (branch-vs-main preview is the first step)
- GitHub PR comments via GitHub Actions
- Runtime tracing from tests to fill gaps in static flows
- Multi-user live views, voice (Cartesia), Elastic search for Ask

## Success criteria

- On the demo repo, the map shows 10–25 sensible components and the main flows read correctly to someone who knows the repo.
- The timelapse plays smoothly: unchanged parts never move or get renamed between frames.
- Every Claude claim (step, caption, answer) points to real functions/files/commits.
- Eval numbers: see "Evaluation" in ARCHITECTURE.md.

## Demo (target)

1. Timelapse of a well-known open-source TypeScript repo's history (30 s).
2. Open a flow, expand a step, ask "why does this exist?" (40 s).
3. Make a change live; Preview shows the architectural impact before committing (40 s).
4. Eval numbers on screen (20 s).

## Sponsor tracks

| Track | Fit |
| --- | --- |
| Factory (Droid SDK) | All AI work runs through Droid with scoped permissions and visible output |
| Anthropic | Named community + Claude central, with guardrails against invented claims |
| Microsoft | Production-minded, measurable, end to end |
| SpacetimeDB | Only if chosen as the store (open decision O1) |
