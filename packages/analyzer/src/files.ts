import { execFileSync } from "node:child_process";
import type { Lang } from "./facts.js";

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.[mc]?ts$/;
const TEST_FILE = /\.(test|spec)\.[^.]+$/;
const CONFIG_FILE = /\.config\.[^.]+$/;
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".catchup",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "e2e",
]);

/** Files git knows about (tracked + untracked-but-not-ignored), relative to the repo root. */
export function listRepoPaths(repoRoot: string): string[] {
  const out = execFileSync("git", ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter((p) => p.length > 0))].sort();
}

/** Source files that describe how the app works: no tests, type declarations, configs or build output. */
export function isSourcePath(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (!CODE_EXT.test(name) || DECLARATION.test(name) || TEST_FILE.test(name) || CONFIG_FILE.test(name)) {
    return false;
  }
  return !segments.slice(0, -1).some((segment) => SKIPPED_DIRS.has(segment));
}

/** Directories (other than the repo root) that contain their own package.json. */
export function findPackageDirs(paths: string[]): string[] {
  return paths
    .filter((p) => p.endsWith("/package.json"))
    .map((p) => p.slice(0, -"/package.json".length))
    .filter((dir) => !dir.split("/").some((segment) => SKIPPED_DIRS.has(segment)))
    .sort();
}

export function languageOf(path: string): Lang {
  return /\.[mc]?tsx?$/.test(path) ? "typescript" : "javascript";
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}
