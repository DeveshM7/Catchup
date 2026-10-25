import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cruise } from "dependency-cruiser";
import type { ICruiseResult, IDependency } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import ts from "typescript";
import { packageOfSpecifier } from "./externals.js";
import { PKG_PREFIX, type ImportFact } from "./facts.js";
import { compareImports } from "./sort.js";

export { packageName } from "./externals.js";

type Resolver = {
  repoRoot: string;
  sourceFiles: Set<string>;
  aliases: string[];
  compilerOptions: ts.CompilerOptions;
};

function aliasPrefixes(paths: Record<string, unknown> | undefined): string[] {
  return Object.keys(paths ?? {})
    .map((key) => key.replace(/\*$/, ""))
    .filter((prefix) => prefix.length > 0);
}

/**
 * dependency-cruiser resolves tsconfig `paths` from the process cwd when the tsconfig has no
 * `baseUrl` (Umami's case), so unresolved specifiers are retried with TypeScript's own resolver.
 */
function resolveWithTypeScript(spec: string, fromFile: string, r: Resolver): string | undefined {
  const resolved = ts.resolveModuleName(spec, join(r.repoRoot, fromFile), r.compilerOptions, ts.sys).resolvedModule;
  if (!resolved || resolved.isExternalLibraryImport) return undefined;
  const path = relative(r.repoRoot, resolved.resolvedFileName).split(sep).join("/");
  return r.sourceFiles.has(path) ? path : undefined;
}

function target(dep: IDependency, fromFile: string, r: Resolver): string | undefined {
  if (dep.coreModule) return undefined;
  const isPackage = dep.resolved.includes("node_modules/") || dep.dependencyTypes.some((t) => t.startsWith("npm"));
  if (!dep.couldNotResolve && !isPackage) {
    return r.sourceFiles.has(dep.resolved) ? dep.resolved : undefined;
  }
  const spec = dep.module;
  if (dep.couldNotResolve) {
    const local = resolveWithTypeScript(spec, fromFile, r);
    if (local !== undefined) return local;
  }
  // Unresolvable local paths (e.g. generated code that isn't checked in) are not packages.
  if (spec.startsWith(".") || spec.startsWith("/") || r.aliases.some((a) => spec.startsWith(a))) return undefined;
  return PKG_PREFIX + packageOfSpecifier(spec);
}

/**
 * Runtime imports between source files, plus imports of packages as `pkg:<name>`.
 * TypeScript is compiled before cruising (`tsPreCompilationDeps: false`), so type-only
 * imports, which never run, are dropped.
 */
export async function extractImports(repoRoot: string, sourceFiles: string[]): Promise<ImportFact[]> {
  if (sourceFiles.length === 0) return [];
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  const tsConfig = existsSync(tsconfigPath) ? extractTSConfig(tsconfigPath) : undefined;
  const result = await cruise(
    sourceFiles,
    {
      baseDir: repoRoot,
      tsPreCompilationDeps: false,
      doNotFollow: { path: "node_modules" },
      ...(tsConfig ? { tsConfig: { fileName: tsconfigPath } } : {}),
    },
    undefined,
    tsConfig ? { tsConfig } : undefined,
  );
  if (typeof result.output === "string") throw new Error("dependency-cruiser returned text instead of a result object");
  return collect(result.output, {
    repoRoot,
    sourceFiles: new Set(sourceFiles),
    aliases: aliasPrefixes(tsConfig?.options.paths),
    compilerOptions: (tsConfig?.options ?? {}) as ts.CompilerOptions,
  });
}

function collect(output: ICruiseResult, r: Resolver): ImportFact[] {
  const seen = new Set<string>();
  const imports: ImportFact[] = [];
  for (const mod of output.modules) {
    if (!r.sourceFiles.has(mod.source)) continue;
    for (const dep of mod.dependencies) {
      const to = target(dep, mod.source, r);
      if (to === undefined || to === mod.source) continue;
      const key = `${mod.source}\0${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push({ from: mod.source, to });
    }
  }
  return imports.sort(compareImports);
}
