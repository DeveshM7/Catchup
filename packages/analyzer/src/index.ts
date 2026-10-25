import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import type { Facts, FileFact, FunctionFact } from "./facts.js";
import { countLines, findPackageDirs, isSourcePath, languageOf, listRepoPaths } from "./files.js";
import { extractFunctions, scriptKind } from "./functions.js";
import { workerStarts } from "./workers.js";
import { extractImports } from "./imports.js";
import { componentName, DEFAULT_GROUPING, groupFiles, type GroupingOptions } from "./structure.js";
import { packagesByComponent, rollUpEdges } from "./edges.js";
import { detectExternals } from "./externals.js";
import type { Component, Snapshot } from "./snapshot.js";
import { compareStrings } from "./sort.js";
import { createProgram } from "./program.js";
import { extractCalls, indexFunctions } from "./calls.js";
import { exportedFunctionIds, findEntrySources } from "./entrysources.js";
import { readPackages } from "./packages.js";
import { detectEntryPoints, uiEntryPoints } from "./entrypoints.js";
import { externalFor } from "./externals.js";
import { fileSides, sideRoots } from "./sides.js";
import { markActionCalls, type Route } from "./links.js";
import { buildCallTree, callsByCaller, DEFAULT_TREE_LIMITS, type CallTree, type TreeLimits } from "./calltree.js";
import { scoreTree } from "./scoring.js";
import { FUNCTION_HASH_VERSION } from "./hash.js";

export * from "./facts.js";
export { FUNCTION_HASH_VERSION } from "./hash.js";
export { refreshFunctionHashes } from "./rehash.js";
export * from "./snapshot.js";
export { DEFAULT_GROUPING, groupFiles, type GroupingOptions } from "./structure.js";
export { EXTERNAL_SYSTEMS, externalFor } from "./externals.js";
export * from "./calltree.js";
export { FAMILY_OVERLAP, flowFamilies, type FlowFamily } from "./families.js";
export { appRouteUrl, pagesApiUrl } from "./entrypoints.js";
export { appPageUrl, pagesPageUrl } from "./entrysources.js";
export { MODULE_UNIT } from "./functions.js";
export { readPackages, sourceForOutput, type PackageInfo } from "./packages.js";
export { computeSignals, type FileSignals, type FunctionSignals, type Signals, type SignalInputs } from "./signals.js";

export type AnalyzeOptions = { grouping?: GroupingOptions };

/** Extract facts and build the structure snapshot for the working tree at `repoRoot`. */
export async function analyze(repoPath: string, sha: string, options: AnalyzeOptions = {}): Promise<{ facts: Facts; snapshot: Snapshot }> {
  // The real path: dependency-cruiser resolves symlinks (macOS `/var` → `/private/var`), and every path must agree.
  const repoRoot = realpathSync(resolve(repoPath));
  const paths = listRepoPaths(repoRoot);
  const sourcePaths = paths.filter(isSourcePath);
  const packages = readPackages(repoRoot, paths, new Set(sourcePaths));
  const texts = new Map<string, string>();
  for (const path of sourcePaths) {
    try {
      texts.set(path, readFileSync(join(repoRoot, path), "utf8"));
    } catch {
      // tracked in the index but deleted from the working tree
    }
  }
  // Bins and worker-thread files run their top-level code: they get a `(module)` unit.
  const moduleFiles = new Set([...packages.flatMap((p) => p.bins.map((b) => b.file)), ...workerFiles(texts)]);
  const files: FileFact[] = [];
  const functions: FunctionFact[] = [];
  for (const [path, text] of texts) {
    files.push({ path, lang: languageOf(path), loc: countLines(text) });
    functions.push(...extractFunctions(path, text, moduleFiles.has(path)));
  }
  const filePaths = files.map((f) => f.path);
  const imports = await extractImports(repoRoot, filePaths);
  functions.sort((a, b) => compareStrings(a.id, b.id));

  const program = createProgram(repoRoot, filePaths);
  const index = indexFunctions(program, repoRoot, filePaths, moduleFiles);
  const exported = exportedFunctionIds(program, repoRoot, filePaths, index);
  for (const fn of functions) if (exported.has(fn.id)) fn.exported = true;
  const entryInputs = {
    files: filePaths,
    functions,
    defaultExportName: (file: string) => defaultExportName(program.getSourceFile(join(repoRoot, file))),
    extra: findEntrySources({ program, repoRoot, files: filePaths, index, packages }),
  };
  // Routes and sides come from conventions alone, before calls: client → server links need both.
  const conventional = detectEntryPoints({ ...entryInputs, calledFunctions: new Set() });
  const routes = conventional
    .filter((e) => e.kind === "http")
    .map((e): Route => ({ method: e.label.slice(0, e.label.indexOf(" ")), url: e.label.slice(e.label.indexOf(" ") + 1), entry: e.id, handler: e.handler }));
  const sides = fileSides(filePaths, imports, sideRoots(program, repoRoot, filePaths, conventional));
  for (const file of files) {
    const side = sides.get(file.path);
    if (side) file.side = side;
  }
  const calls = extractCalls(program, repoRoot, filePaths, imports, index, routes, sides);
  markActionCalls(calls, conventional, sides);
  const calledFunctions = new Set(calls.flatMap((c) => (c.kind === "direct" && c.to !== null ? [c.to] : [])));
  const ui = uiEntryPoints(calls, (pkg) => externalFor(pkg) !== undefined);
  const entryPoints = detectEntryPoints({ ...entryInputs, extra: [...entryInputs.extra, ...ui], calledFunctions });

  const facts: Facts = { sha, hashVersion: FUNCTION_HASH_VERSION, files, functions, imports, calls, entryPoints };
  const snapshot = buildSnapshot(facts, findPackageDirs(paths), options.grouping ?? DEFAULT_GROUPING);
  return { facts, snapshot };
}

export function buildSnapshot(facts: Facts, packageDirs: string[], grouping: GroupingOptions): Snapshot {
  const { componentOf, kinds } = groupFiles(
    facts.files.map((f) => f.path),
    packageDirs,
    grouping,
  );
  const packages = packagesByComponent(facts.imports, componentOf);
  const byId = new Map<string, Component>();
  for (const file of facts.files) {
    const id = componentOf.get(file.path);
    if (id === undefined) continue;
    const component = byId.get(id) ?? {
      id,
      name: componentName(id),
      kind: kinds.get(id) ?? "folder",
      files: [],
      loc: 0,
      functionCount: 0,
      packages: [...(packages.get(id) ?? [])].sort(compareStrings),
    };
    component.files.push(file.path);
    component.loc += file.loc;
    byId.set(id, component);
  }
  for (const fn of facts.functions) {
    const component = byId.get(componentOf.get(fn.file) ?? "");
    if (component) component.functionCount += 1;
  }
  const components = [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
  const edges = rollUpEdges(facts.imports, componentOf);
  const externals = detectExternals(packages);
  return {
    sha: facts.sha,
    components,
    edges,
    externals,
    summary: {
      files: facts.files.length,
      functions: facts.functions.length,
      imports: facts.imports.length,
      components: components.length,
      externals: externals.length,
    },
  };
}

/** Files some `new Worker(…)` starts (D52). */
function workerFiles(texts: Map<string, string>): string[] {
  const known = new Set(texts.keys());
  return [...texts].flatMap(([path, text]) =>
    text.includes("Worker") ? workerStarts(path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path)), known).map((w) => w.file) : [],
  );
}

function defaultExportName(sourceFile: ts.SourceFile | undefined): string | undefined {
  for (const statement of sourceFile?.statements ?? []) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      return statement.expression.text;
    }
  }
  return undefined;
}

/** file path → component id, from a snapshot. */
export function componentIndex(snapshot: Snapshot): Map<string, string> {
  const index = new Map<string, string>();
  for (const component of snapshot.components) for (const file of component.files) index.set(file, component.id);
  return index;
}

/** Scored call trees for every entry point (D21). */
export function buildCallTrees(facts: Facts, snapshot: Snapshot, limits: TreeLimits = DEFAULT_TREE_LIMITS): CallTree[] {
  const components = componentIndex(snapshot);
  const functions = new Map(facts.functions.map((fn) => [fn.id, fn]));
  const byCaller = callsByCaller(facts.calls);
  return facts.entryPoints.map((entry) =>
    scoreTree(
      buildCallTree(facts, entry, (file) => components.get(file) ?? "?", limits, byCaller),
      { functions },
    ),
  );
}
