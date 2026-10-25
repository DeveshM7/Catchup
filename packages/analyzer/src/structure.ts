import type { ComponentKind } from "./snapshot.js";
import { compareStrings } from "./sort.js";

export type GroupingOptions = {
  /** A depth-1 folder with more files than this splits into its depth-2 folders. */
  splitAbove: number;
  /** A folder with fewer files than this merges into its parent. */
  mergeBelow: number;
  /** Upper bound on components; the smallest folders merge into their parents until it holds. */
  maxComponents: number;
};

/** D19. */
export const DEFAULT_GROUPING: GroupingOptions = { splitAbove: 80, mergeBelow: 5, maxComponents: 25 };

export type Grouping = {
  /** file path → component id */
  componentOf: Map<string, string>;
  kinds: Map<string, ComponentKind>;
};

const ROOT = ".";

/** Folder ids for a file outside workspace packages. `src/` is transparent: `src/app/api/x.ts` → `src/app`, `src/app/api`. */
function folderChain(path: string): { base: string; depth1?: string; depth2?: string } {
  const segments = path.split("/").slice(0, -1);
  const offset = segments[0] === "src" ? 1 : 0;
  const base = offset === 1 ? "src" : ROOT;
  const depth1 = segments.length > offset ? segments.slice(0, offset + 1).join("/") : undefined;
  const depth2 = segments.length > offset + 1 ? segments.slice(0, offset + 2).join("/") : undefined;
  return {
    base,
    ...(depth1 === undefined ? {} : { depth1 }),
    ...(depth2 === undefined ? {} : { depth2 }),
  };
}

function owningPackage(path: string, packageDirs: string[]): string | undefined {
  let best: string | undefined;
  for (const dir of packageDirs) {
    if (path.startsWith(`${dir}/`) && (best === undefined || dir.length > best.length)) best = dir;
  }
  return best;
}

function parentOf(id: string): string {
  const cut = id.lastIndexOf("/");
  if (cut === -1) return ROOT;
  const parent = id.slice(0, cut);
  return parent;
}

function countBy(componentOf: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of componentOf.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function reassign(componentOf: Map<string, string>, from: string, to: string): void {
  for (const [file, id] of componentOf) if (id === from) componentOf.set(file, to);
}

/** Groups files into components with one fixed rule, identical at every commit (D19). */
export function groupFiles(files: string[], packageDirs: string[], options: GroupingOptions = DEFAULT_GROUPING): Grouping {
  const componentOf = new Map<string, string>();
  const kinds = new Map<string, ComponentKind>();
  const chains = new Map<string, ReturnType<typeof folderChain>>();
  const depth1Counts = new Map<string, number>();

  for (const file of [...files].sort(compareStrings)) {
    const pkg = owningPackage(file, packageDirs);
    if (pkg !== undefined) {
      componentOf.set(file, pkg);
      kinds.set(pkg, "package");
      continue;
    }
    const chain = folderChain(file);
    chains.set(file, chain);
    if (chain.depth1 !== undefined) depth1Counts.set(chain.depth1, (depth1Counts.get(chain.depth1) ?? 0) + 1);
  }

  const split = new Set([...depth1Counts].filter(([, n]) => n > options.splitAbove).map(([id]) => id));
  for (const [file, chain] of chains) {
    if (chain.depth1 === undefined) componentOf.set(file, chain.base);
    else if (split.has(chain.depth1) && chain.depth2 !== undefined) componentOf.set(file, chain.depth2);
    else componentOf.set(file, chain.depth1);
  }

  const baseOf = (id: string): string => (id === "src" || id.startsWith("src/") ? "src" : ROOT);
  const isBase = (id: string): boolean => id === "src" || id === ROOT;
  const isDepth2 = (id: string): boolean => !isBase(id) && kinds.get(id) !== "package" && !depth1Counts.has(id);
  const mergeTarget = (id: string): string => (isDepth2(id) ? parentOf(id) : baseOf(id));

  let counts = countBy(componentOf);
  for (const [id, n] of [...counts].sort(([a], [b]) => compareStrings(a, b))) {
    if (isDepth2(id) && n < options.mergeBelow) reassign(componentOf, id, parentOf(id));
  }
  counts = countBy(componentOf);
  for (const [id, n] of [...counts].sort(([a], [b]) => compareStrings(a, b))) {
    if (depth1Counts.has(id) && !split.has(id) && n < options.mergeBelow) reassign(componentOf, id, baseOf(id));
  }

  for (;;) {
    counts = countBy(componentOf);
    if (counts.size <= options.maxComponents) break;
    const candidates = [...counts]
      .filter(([id]) => !isBase(id) && kinds.get(id) !== "package")
      .sort(([a, x], [b, y]) => x - y || compareStrings(a, b));
    const smallest = candidates[0];
    if (smallest === undefined) break;
    reassign(componentOf, smallest[0], mergeTarget(smallest[0]));
  }

  for (const id of new Set(componentOf.values())) {
    if (!kinds.has(id)) kinds.set(id, isBase(id) ? "root" : "folder");
  }
  return { componentOf, kinds };
}

export function componentName(id: string): string {
  return id === ROOT ? "(root)" : (id.split("/").at(-1) ?? id);
}
