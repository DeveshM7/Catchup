# Target output: egoist/tsup @ 198479b

_Hand-written, 2026-10-25, for Build 4 (D35, D41). What Catchup should show a developer opening tsup for the first time. Every claim cites code. Same two layers as `docs/targets/ai-chatbot.md`; the last section lists what the pipeline does today and the gaps, so fixes stay general (no tsup-specific rules)._

---

# Layer 1: first screen

**What it is.** A command-line bundler for TypeScript libraries: it turns your source files into ready-to-publish JavaScript (CommonJS, ESM or IIFE) and type declaration files, using esbuild.

**The parts.**

```
 CLI ──▶ Build orchestrator ──▶ esbuild bundling ──▶ Output plugins ──▶ dist/
              │   ▲ config                                    (minify, tree-shake, cjs)
              │   └─ Config loading
              └──▶ Type declarations (Rollup + dts plugin, or tsc + API Extractor) ──▶ dist/*.d.ts
```

**How it works, in one flow.**
1. You run `tsup src/index.ts` → the CLI turns flags into options.
2. tsup finds and loads `tsup.config.*`, merges it with the flags and checks the entries.
3. For each output format, esbuild bundles the code (dependencies stay external), then tsup's plugins post-process every chunk and write it to `dist/`.
4. In parallel, a worker builds `.d.ts` files if `--dts` is on. With `--watch`, it rebuilds when an imported file changes.

**Start here:** `src/index.ts`

---

# Layer 2: on click

## 1. What this is (brief)

tsup is a zero-config bundler for libraries. The `tsup` and `tsup-node` commands (`package.json` `bin`) share one CLI (`src/cli-main.ts#main`); `tsup-node` only adds `skipNodeModulesBundle`. The same `build()` is also a library function, with `defineConfig()` for typed config files. JavaScript is built by **esbuild** (`src/esbuild/index.ts#runEsbuild`), and each output chunk goes through tsup's own **plugin container** (`src/plugin.ts#PluginContainer`) before it is written. Declarations are built separately: by default with **Rollup + rollup-plugin-dts** in a worker thread (`src/rollup.ts`), or experimentally with the **TypeScript compiler + API Extractor** (`src/tsc.ts`, `src/api-extractor.ts`). The README says the project is no longer actively maintained (tsdown is the successor).

## 2. Key ideas (glossary)

| Idea | What it means here | Where |
| --- | --- | --- |
| **Options / NormalizedOptions** | Everything a build needs. CLI flags and the config file are merged (flags win), then normalized: formats become a list, entries are globbed and checked, tsconfig and target are filled in. | `src/options.ts`, `src/index.ts#normalizeOptions` |
| **Config file** | `tsup.config.{ts,js,json,…}` or a `tsup` key in `package.json`, found upward from the cwd. It may export an array (several builds) or a function of the CLI options. | `src/load.ts#loadTsupConfig`, `src/index.ts#defineConfig` |
| **Format** | `cjs`, `esm` or `iife`. Each format is a separate esbuild run with its own plugin container, all in parallel. | `src/index.ts#build` (the `buildAll` closure) |
| **tsup plugins** | Hooks around esbuild's output: `esbuildOptions`, `buildStart`, `renderChunk` (rewrite each chunk), `buildEnd`. Built in: shebang, tree-shaking, cjs-splitting, cjs-interop, swc-target, size-reporter, terser. Separate from **esbuild plugins** (externals, node protocol, postcss, svelte, swc decorators, native modules). | `src/plugin.ts`, `src/plugins/*`, `src/esbuild/*` |
| **External dependencies** | `dependencies` and `peerDependencies` from package.json are never bundled; `--external` / `noExternal` adjust that; `tsup-node` externalizes every package import. | `src/esbuild/external.ts#externalPlugin`, `src/load.ts#getProductionDeps` |
| **dts vs experimentalDts** | Two ways to build declarations, mutually exclusive. `dts`: Rollup + rollup-plugin-dts in a worker thread. `experimentalDts`: emit with tsc, then bundle with API Extractor. | `src/index.ts#build` (`dtsTask`), `src/rollup.ts`, `src/tsc.ts#runTypeScriptCompiler`, `src/api-extractor.ts#runDtsRollup` |

## 3. The flow that matters: building a library

_From the command line to `dist/`. Checks are one line, not steps._

1. **The CLI reads the command.** `cac` parses flags; the `[...files]` command's action (`src/cli-main.ts#main`) turns positional files into `entry`, splits comma lists (`format`, `external`, `inject`, `loader`), builds the `dts` options, then imports and calls `build()`.
2. **Load the config and merge options.** `loadTsupConfig` finds a config (bundled with `bundle-require` when it's code); a function config is called with the CLI options; an array means several builds in parallel. `normalizeOptions` merges each with the flags, globs the entries and reads tsconfig (paths, decorator metadata, target).
   _Checks:_ no entry → "No input files"; a named entry that doesn't exist; a missing custom tsconfig; `dts` and `experimentalDts` together.
3. **Bundle each format with esbuild.** `buildAll` optionally cleans `outDir`, then for every format builds a `PluginContainer` and calls `runEsbuild`. It marks production deps external, picks output extensions, adds esbuild plugins (externals, postcss/svelte CSS, swc for decorator metadata) and runs esbuild with `write: false`.
4. **Post-process and write each chunk.** `PluginContainer.buildFinished` passes every JS/CSS chunk through the tsup plugins' `renderChunk` (Rollup tree-shaking, esm→cjs with sucrase for cjs splitting, swc down to es5, terser), merges source maps, writes files to `dist/` (executable when the chunk starts with `#!`) and reports sizes.
5. **Declarations, in parallel.** If `dts` is on, a worker thread runs `src/rollup.ts`: Rollup with rollup-plugin-dts writes `.d.ts`/`.d.mts`/`.d.cts` per format. With `experimentalDts`, tsc emits declarations into `.tsup/declaration` and API Extractor rolls them into one file per entry.
6. **After success.** Copies the public dir, runs `onSuccess` (a shell command or a function). In watch mode, chokidar watches the paths; a change to a file the last build imported (from esbuild's metafile) triggers a debounced rebuild, and a `package.json` change only if dependencies changed.

_Variant:_ **`tsup-node`** is the same flow with every `node_modules` import left external.

## 4. Other flows, one line each

| Flow | One line |
| --- | --- |
| `build()` from code | The library entry: same as step 2 onward, with options passed in instead of flags. |
| `defineConfig()` | Returns its argument unchanged; it exists so config files get type checking. |
| Watch mode | `startWatcher` (in `build`) rebuilds on changes to imported files; the dts worker watches separately through `rollup.watch`. |

## 5. Start here

1. `src/index.ts`: `build()`, option normalization, the format loop, dts tasks and watch mode. The whole orchestration.
2. `src/esbuild/index.ts`: how one format is bundled (externals, loaders, defines, esbuild plugins).
3. `src/plugin.ts` + `src/plugins/`: what happens to each chunk before it is written.
4. `src/cli-main.ts`: every CLI flag and how it maps to options.

## 6. Common changes: where to go

| I want to… | Touch |
| --- | --- |
| Add a CLI flag | `src/cli-main.ts#main` (option + mapping), `src/options.ts` (type), `schema.json` |
| Add a built-in output transform | new file in `src/plugins/`, add it to the `PluginContainer` list in `src/index.ts#build` |
| Change how a format is bundled | `src/esbuild/index.ts#runEsbuild` |
| Change which imports stay external | `src/esbuild/external.ts#externalPlugin`, `src/load.ts#getProductionDeps` |
| Change declaration output | `src/rollup.ts` (dts) or `src/tsc.ts` + `src/api-extractor.ts` (experimentalDts) |
| Support a new config file name | `src/load.ts#loadTsupConfig` |

## 7. Surprises worth flagging

- **The dts build is started by file path, not by import.** `build` spawns `new Worker(path.join(__dirname, "./rollup" + ext))`, so `src/rollup.ts` is reached only at runtime. In watch mode the worker is never terminated (`terminateWorker` returns early).
- **A failed dts build reports both "error" and "success".** `runRollup` catches its own error and `handleError` posts `"error"` from the worker; `startRollup` then posts `"success"` too. The main thread happens to act on the first message.
- **Terser failures don't fail the build.** `terserPlugin`'s `renderChunk` logs the error and returns the unminified code.
- **CJS splitting and old targets are two-pass.** With `splitting` on a cjs build (or `treeshake`), esbuild emits ESM and the chunk is converted afterwards (sucrase in `cjsSplitting`, Rollup in `treeShakingPlugin`). Targets `es5`/`es3` build as `es2020` and are lowered by swc in `swcTarget`.
- **Dead code.** `src/run.ts#runCode`, `src/utils.ts#isExternal`, `#pathExists` and `#trimDtsExtension` are exported but nothing in `src/` or `test/` calls them.

---

## What this target asks of the pipeline (vs. what we show today)

_Today = `catchup init` + `catchup flow` at 198479b, before Build 4 fixes._

| Target needs | Today | Gap (fix with a general rule) |
| --- | --- | --- |
| Entry points: `$ tsup`, `$ tsup-node`, the command, `build()`, `defineConfig()` | all 5 found (D42) | none |
| The bin journey reaches esbuild and the plugins | `$ tsup` stops at depth 8 (53 functions vs 99 for the command itself): `(module)` → `main` → command closure → `build` uses 3 levels before the work starts | depth limit counts levels that only pass through (or raise it for CLI entries); generic |
| Outside tools shown: esbuild, Rollup, TypeScript compiler, API Extractor, swc, terser, file system writes | "systems: none": the externals table only knows services (DBs, APIs, AI) | a build tool's engines are its "outside systems". Either a second table of tool packages (esbuild, rollup, typescript, swc, terser, postcss) shown as tools, or show heavy-use packages per flow. Needs a decision |
| Step 4 (post-processing) visible | the plugin factories are reached, but their `renderChunk` methods are anonymous (methods in a returned object literal) and are called through `plugin.renderChunk.call(…)`, so the tree-shaking/terser/sucrase/swc work is invisible | name methods of an object a function returns (`shebang.renderChunk`), and link a call through a list of such objects (`plugins[i].hook`) to every factory's hook, flagged `oneOf`. Like D33's factory configs |
| Step 5 (dts worker) visible | `src/rollup.ts` is in no tree (`new Worker(path)`) | link `new Worker(<path to our file>)` to that file's module unit, as a passed call. Generic for worker threads |
| Flows complete | every flow is "partial": `new Function(…)` in `jsoncParse`, `new AliasPool()` (local class without a constructor), plugin-object methods | a local class without a constructor is not dynamic (nothing to call); `new Function` stays dynamic |
| 2 parts or more by role (CLI, orchestrator, config, esbuild, output plugins, declarations, utilities) | D19 gives 5 folder groups (`src`, `src/esbuild`, `src/plugins`, …), 36 files | the Survey pass should do this (Build 2); checked by the first real run |

### After the first Build 4 fixes (D52, D53)

- Bin journey: 115 functions (was 53), reaching esbuild, the output plugin factories, the dts worker (`src/rollup.ts#(module)` → `on:message` → `startRollup`) and the TypeScript compiler.
- Tools: esbuild, Rollup, Sucrase, TypeScript compiler, PostCSS found. Terser and SWC are loaded with `localRequire("terser")` (a dynamic `require`) and stay unseen.
- Still partial, honestly: `new Function` in `jsoncParse`, the stored `onSuccess` cleanup, `minify`/`sveltePreprocessor` from `localRequire`, a debounce callback.
- Output plugins' `renderChunk` hooks: still invisible; left as a known limit until the Understand run shows whether the agent covers them from the code (user choice).

