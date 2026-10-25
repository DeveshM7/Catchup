import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirs } from "./files.js";

export type PackageInfo = {
  /** Repo-relative folder; "" for the root. */
  dir: string;
  name: string;
  private: boolean;
  /** CLI commands from `bin`, mapped to the source file that builds them. */
  bins: { name: string; file: string }[];
  /** Import paths from `exports` / `main` / `module`, mapped to source files ("." = the package itself). */
  entries: { subpath: string; file: string }[];
};

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const OUTPUT_DIR = /^(dist|build|lib|out|esm|cjs)\//;

/** The source file a published path is built from: `dist/cli.js` → `src/cli.ts` (or the file itself). */
export function sourceForOutput(dir: string, output: string, sourceFiles: Set<string>): string | undefined {
  const rel = output.replace(/^\.\//, "");
  if (/\.d\.[mc]?ts$/.test(rel) || rel.endsWith(".json")) return undefined;
  const base = rel.replace(/\.[mc]?[jt]sx?$/, "");
  const stems = [base, base.replace(OUTPUT_DIR, "src/"), base.replace(OUTPUT_DIR, "")];
  const prefix = dir === "" ? "" : `${dir}/`;
  const candidates = [rel, ...stems.flatMap((s) => [...SOURCE_EXTS.map((e) => s + e), ...SOURCE_EXTS.map((e) => `${s}/index${e}`)])];
  return candidates.map((c) => prefix + c).find((c) => sourceFiles.has(c));
}

type Json = { [key: string]: unknown };

function outputsOf(exportsField: unknown, subpath = "."): { subpath: string; path: string }[] {
  if (typeof exportsField === "string") return [{ subpath, path: exportsField }];
  if (Array.isArray(exportsField)) return exportsField.flatMap((e) => outputsOf(e, subpath));
  if (exportsField === null || typeof exportsField !== "object") return [];
  return Object.entries(exportsField as Json).flatMap(([key, value]) =>
    key.startsWith(".") ? outputsOf(value, key) : key === "types" ? [] : outputsOf(value, subpath),
  );
}

function packageInfo(repoRoot: string, dir: string, sourceFiles: Set<string>): PackageInfo | undefined {
  let json: Json;
  try {
    json = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as Json;
  } catch {
    return undefined;
  }
  const name = typeof json.name === "string" ? json.name : dir || "package";
  const binField = json.bin;
  const binEntries: [string, unknown][] =
    typeof binField === "string" ? [[name.replace(/^@[^/]+\//, ""), binField]] : binField && typeof binField === "object" ? Object.entries(binField as Json) : [];
  const bins = binEntries.flatMap(([bin, path]) => {
    const file = typeof path === "string" ? sourceForOutput(dir, path, sourceFiles) : undefined;
    return file ? [{ name: bin, file }] : [];
  });
  const outputs = [...outputsOf(json.exports), ...outputsOf(json.module), ...outputsOf(json.main)];
  const seen = new Set<string>();
  const entries = outputs.flatMap(({ subpath, path }) => {
    const file = sourceForOutput(dir, path, sourceFiles);
    if (!file || seen.has(`${subpath}\n${file}`)) return [];
    seen.add(`${subpath}\n${file}`);
    return [{ subpath, file }];
  });
  return { dir, name, private: json.private === true, bins, entries };
}

/** Every package.json in the repo (root first), with bins and exports mapped to source files. */
export function readPackages(repoRoot: string, paths: string[], sourceFiles: Set<string>): PackageInfo[] {
  const dirs = [...(paths.includes("package.json") ? [""] : []), ...findPackageDirs(paths)];
  return dirs.flatMap((dir) => packageInfo(repoRoot, dir, sourceFiles) ?? []);
}
