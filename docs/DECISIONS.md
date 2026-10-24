# Catchup — Decisions

_Append-only log. Each entry: what we decided, why, and what we rejected. Change a decision by adding a new entry that supersedes the old one — don't edit history._

## Made

| # | Date | Decision | Why | Rejected |
| --- | --- | --- | --- | --- |
| D1 | 2026-10-24 | Structure and call trees are computed deterministically from code; Claude only groups, names and explains | Stable IDs, exact diffs, can't invent components; required for a timelapse | LLM writes the whole architecture (Archify, DeepWiki, PR Lens approach) — drifts between snapshots |
| D2 | 2026-10-24 | Import graph alone is not enough; add a behavior layer: entry points → call trees → flows | Users need to see how the code runs, not just what imports what | Dependency graph only |
| D3 | 2026-10-24 | Claude groups call trees into 4–8 steps per flow, with drill-down levels; code validates coverage | A raw call tree is 100s of functions; needs judgment on what matters | Showing raw call trees; code-only heuristics |
| D4 | 2026-10-24 | After the first snapshot, every update is an *edit* of the previous snapshot; unchanged steps are copied without calling Claude | Consistency across commits; cheap | Regenerating each checkpoint independently |
| D5 | 2026-10-24 | Hierarchy: overview → 3–7 areas → flows (one per entry point) → steps → functions; parallel processes as lanes; coverage rule puts leftovers in "Other" | Shows the whole system without hiding anything | Single flat diagram |
| D6 | 2026-10-24 | Commits are the record (one snapshot per checkpoint); the working tree is a live preview, never stored | Git history gives the timelapse for free; users want to review agent changes before committing | Claude Code SessionEnd as trigger (sessions are restarted arbitrarily); every-save snapshots |
| D7 | 2026-10-24 | History = ~15 sampled checkpoints (time-spaced + tags), processed oldest → newest | Analyzing every commit is slow and makes a noisy timelapse | Every commit |
| D8 | 2026-10-24 | Language-neutral facts format; only the extractor is per-language. Build TypeScript first | Real repos are multi-language; scope is a time limit, not a design limit | Language-specific pipeline |
| D9 | 2026-10-24 | Claude outputs JSON validated by Zod schemas; our code renders everything (elkjs layout + Cytoscape.js) | Same data always draws the same picture; Claude's words can change without the layout jumping | Claude generating diagrams/SVG/Mermaid |
| D10 | 2026-10-24 | One layout over the union of all snapshots | Nothing moves between timelapse frames; only appears, changes color, or fades | Re-layout per frame |
| D11 | 2026-10-24 | Ask = read-only Droid session with a starting brief + repo tools; citations verified | Grounded answers; satisfies Factory's "safe, visible" criteria | Chatbot over a vector index only |
| D12 | 2026-10-24 | All AI calls go through the Factory Droid SDK (TypeScript), Claude as model | Factory track; permission handlers and autonomy levels built in | Direct Anthropic API calls |
| D13 | 2026-10-24 | Don't fork unkode / PR Lens / Archify; reuse libraries only (dependency-cruiser, TS compiler API, simple-git, elkjs, Cytoscape.js, chokidar, React/Vite, Zod) | Their core is LLM-authored structure (conflicts with D1); hackathon builds should be original | Forking an existing tool |
| D14 | 2026-10-24 | Team/branch scoping, GitHub PR comments, runtime tracing, more languages, voice, Elastic are post-hackathon | Scope | — |

## Open

| # | Question | Options | Decide by |
| --- | --- | --- | --- |
| O1 | Storage | Local JSON in `.catchup/` (simpler) vs SpacetimeDB (sponsor track, live push to dashboard) | Before phase 2 — switching later is costly |
| O2 | Demo repo | A well-known TypeScript repo, 1–3 years of history, clear folders, has HTTP routes (Express/Fastify/Next.js) | Phase 0 |
| O3 | Function-body hash normalization | Raw text vs AST-normalized (ignore whitespace/comments) | Phase 1 |
| O4 | Is `.catchup/` committed to the repo or gitignored? | Committed = history travels with the repo; ignored = no repo noise | Phase 2 |
