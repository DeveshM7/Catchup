import type { CallTree, CallSite, FunctionFact, TreeNode } from "@catchup/analyzer";

const MARK = { important: "★", normal: "•", noise: "·" } as const;

export type TreeFormatOptions = { showNoise: boolean; functions: Map<string, FunctionFact> };

function siteFlags(site: CallSite | undefined): string[] {
  if (!site) return [];
  return [
    ...(site.onError ? ["on error"] : site.conditional ? ["if"] : []),
    ...(site.parallel ? ["parallel"] : []),
    ...(site.oneOf ? ["one of"] : []),
    ...(site.passed ? ["passed as callback"] : []),
    ...(site.remote ? [`request → ${site.remote}`] : []),
    ...(site.message ? [`message "${site.message}"`] : []),
    ...(site.render ? ["renders"] : []),
  ];
}

function describe(node: TreeNode, options: TreeFormatOptions): string {
  const flags = siteFlags(node.site);
  if (node.kind === "external") {
    const what = node.system ? `${node.system} (${node.package})` : node.package;
    flags.push(...(node.writes ? ["writes"] : []));
    return `${MARK[node.importance]} ⇢ ${what}: ${node.callee}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
  }
  if (node.kind === "dynamic") {
    return `${MARK[node.importance]} ? ${node.callee}  (target only known at runtime)${flags.length ? `  [${flags.join(", ")}]` : ""}`;
  }
  if (node.kind === "callback") {
    return `${MARK[node.importance]} ↩ ${node.callee}  (runs a function shown where it is defined)${flags.length ? `  [${flags.join(", ")}]` : ""}`;
  }
  const fact = options.functions.get(node.fn);
  const name = fact?.name ?? node.fn;
  const where = fact ? `${fact.file}:${fact.startLine}` : node.fn;
  if (node.stop === "repeat") flags.push("shown above");
  if (node.stop === "cycle") flags.push("recursive");
  if (node.stop === "depth") flags.push("depth limit");
  if (node.stop === "size") flags.push("size limit");
  if (node.stop === "event") flags.push(`on ${node.site?.event ?? "event"}, its own flow`);
  return `${MARK[node.importance]} ${name}  ${where}  {${node.component}}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
}

/** Text rendering of a call tree; noise is hidden (but counted) unless `showNoise`. */
export function formatTree(tree: CallTree, options: TreeFormatOptions): string {
  const lines: string[] = [];
  const header = `${tree.entryPoint.label}  →  ${tree.entryPoint.handler}`;
  lines.push(header);
  lines.push(
    `${tree.functionCount} functions · systems: ${tree.systems.join(", ") || "none"} · ${tree.partial ? `partial (${tree.dynamicCalls.length} runtime-only calls)` : "complete"}`,
  );
  const walk = (nodes: TreeNode[], prefix: string): void => {
    const shown = options.showNoise ? nodes : nodes.filter((n) => n.importance !== "noise");
    const hidden = nodes.length - shown.length;
    shown.forEach((node, i) => {
      const last = i === shown.length - 1 && hidden === 0;
      lines.push(`${prefix}${last ? "└─ " : "├─ "}${describe(node, options)}`);
      if (node.kind === "function") walk(node.children, `${prefix}${last ? "   " : "│  "}`);
    });
    if (hidden > 0) lines.push(`${prefix}└─ (${hidden} noise hidden)`);
  };
  lines.push(describe(tree.root, options));
  walk(tree.root.children, "");
  return lines.join("\n");
}
