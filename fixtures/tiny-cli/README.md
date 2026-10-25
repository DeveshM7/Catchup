# tiny-cli

Fixture for Catchup tests (Build 1): a CLI (`bin` → `src/cli.ts`, cac-style commands) that is also a library (`build`, `defineConfig`, `init` from `src/index.ts`). Known answers live in `packages/analyzer/src/tinycli.test.ts`.
- `src/dts.ts` runs in a worker thread started from `build` by file path (D52) and drives the TypeScript compiler (a tool, D53).
