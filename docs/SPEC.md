# Catchup — Product Spec

_Last updated: 2026-10-25. Roadmap in D35; every part below is built (see `PLAN.md`)._

## One line

Catchup lets a developer keep track of what their code does, what it used to do, how it changed, and what their uncommitted changes are about to do, as architecture and flow diagrams you can zoom from "what is this app" down to a single function.

## The problem

- Coding agents change large projects faster than a person can follow. After a few days you no longer know your own codebase.
- Opening an unfamiliar repo, it's hard to see what the parts are, how a request actually runs through them, and how the design evolved.
- Existing tools show a repo's current state (DeepWiki, Archify) or one PR's diff (unkode, PR Lens). None lets you choose your depth, and none shows how flows changed over time together with a preview of your next change.

## Who it's for

Any developer on a repo: someone new who needs the big picture fast, and the person who wrote it who needs to see what changed without being buried in explanations. Same tool, different depth (zoom) and amount of text (familiarity toggle).

## The three parts (built in this order, D35)

### Part 1 — Understand (Builds 1–4)

- **One tree, two views (D37).** *Architecture:* the system → its main parts → sub-parts → files → functions. *Flows:* the main journeys ("send a chat message") → their steps → sub-steps → call tree → source. Steps show which parts they run through; parts show which journeys use them.
- **Zoom by clicking.** Click a box to open what's inside it; breadcrumbs take you back up. Big areas have more levels, small ones fewer (Claude picks the depth, code sets limits).
- **Text where it helps.** Each box has a short and a long description. A **familiarity toggle** (new / familiar / expert, D40) picks how much text shows, where you start, and whether error paths and code names appear. You can switch it any time.
- **End to end.** Journeys start where the user acts (a page, a button, a CLI command, a library call) and follow the code through the client, the server, the AI model and outside systems, and back (D39).
- **Real code underneath.** Every box points to real files and functions; the deepest level is the source.

### Part 2 — Ask (Build 5)

- Ask in a general chat, or on any box. A read-only agent answers, citing boxes, functions, files and commits; the boxes it talks about are highlighted on the diagram.

### Part 3 — Changes (Builds 6–9)

- **Snapshots per commit.** Catchup knows what the code did at each commit; unchanged parts keep the same boxes, names and text.
- **Live preview.** Uncommitted changes are analyzed as you save; the diagram puts what changed first: added, changed and removed parts and steps, and behavior changes such as "now writes to Redis" or "a sign-in check was removed".
- **Ask about changes.** Ask why a part or step changed, or what a change will affect.
- **Timelapse A → B.** Play the changes between two commits, with highlights and short captions citing commits.

## What the user sees

A local web dashboard (`catchup open`), Archify-inspired look (D28):

- **Home:** one sentence on what the app is, the top parts diagram, the main journeys, where to start reading.
- **Architecture** and **Flows** tabs over the same tree, with breadcrumbs and a side panel (text, code links, Ask).
- **Preview:** uncommitted changes, behavior first, re-analyzed on every save.
- **Timelapse:** the code's history between two commits, with a cited caption per step.
- **Ask:** a chat beside every view, about the code or about a change.

## Scope now

- TypeScript/JavaScript repos, small to medium (demo: `vercel/ai-chatbot`, D30; generality check: a small TS CLI tool or library, D39; Umami as a large regression test).
- Architecture shows code parts and outside systems only.

## Later

- More languages; DB tables, config/env and screens as their own layers; team/branch scoping; PR comments; runtime tracing to fill static gaps; editor extension.

## Success criteria

- **Newcomer:** on the demo repo, the home screen is readable in under a minute and matches the hand-written target (`docs/targets/ai-chatbot.md`) in substance.
- **Expert:** any function is at most 3 clicks from home; the expert setting shows no prose they didn't ask for.
- **Grounded:** every claim (box, step, answer, caption) points to real functions/files/commits (validator: 100%).
- **Stable:** a re-run on the same commit changes nothing; across commits, unchanged boxes keep ID, text and position.
- **General:** the same pipeline gives a sensible tree on a non-web TS repo without repo-specific rules.

## Hackathon (Cal Hacks 13.0)

| Track | Fit |
| --- | --- |
| Factory (Droid SDK) | All AI work runs through Droid with scoped permissions and visible output |
| Anthropic | Named community + Claude central, with guardrails against invented claims |
| Microsoft | Production-minded, measurable, end to end |
