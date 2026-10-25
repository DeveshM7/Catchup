# tiny-changes

Two versions of one small app for Build 6 (tree per commit + diff). Tests copy `v1` into a temporary git repo, commit,
replace it with `v2`, and commit again. Planted changes from v1 to v2 (known answers in `packages/agent/src/evolve.test.ts`):

1. New module: `lib/export.ts` and a new route `GET /api/export`.
2. Rename: `lib/fetcher.ts` → `lib/http.ts` (same content).
3. New external call: `saveChat` in `lib/db.ts` now also calls Redis (`ioredis`).
4. Removed check: `POST /api/chat` no longer calls `requireUser` from `lib/auth.ts`.
