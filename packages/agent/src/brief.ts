import type { CallTree, FunctionFact, TreeNode } from "@catchup/analyzer";

export type BriefInputs = {
  functions: Map<string, FunctionFact>;
  /** Reads a repo file; undefined when missing. */
  readFile: (path: string) => string | undefined;
};

const MAX_SNIPPET_LINES = 25;
const MAX_SNIPPETS = 14;

function flags(node: TreeNode): string {
  const site = node.site;
  const list = [
    site?.onError ? "on error" : site?.conditional ? "if" : "",
    site?.parallel ? "parallel" : "",
    site?.oneOf ? "one of" : "",
    site?.tool ? "AI tool" : site?.event ? `on ${site.event}` : site?.render ? "renders" : site?.passed ? "passed as callback" : "",
    site?.remote ? `request → ${site.remote}` : "",
    site?.message ? `message "${site.message}"` : "",
    node.kind === "external" && node.writes ? "writes" : "",
    node.kind === "function" && node.stop === "repeat" ? "shown above" : "",
    node.kind === "function" && node.stop === "cycle" ? "recursive" : "",
    node.kind === "function" && node.stop === "event" ? "user action, its own flow" : "",
    node.kind === "function" && node.stop === "message" ? "receives it in the browser" : "",
    node.kind === "function" && (node.stop === "depth" || node.stop === "size") ? "not expanded" : "",
  ].filter(Boolean);
  return list.length ? ` [${list.join(", ")}]` : "";
}

function describe(node: TreeNode, inputs: BriefInputs): string {
  const mark = node.importance === "important" ? "★ " : "";
  if (node.kind === "external") return `${mark}⇢ ${node.system ?? node.package}: ${node.callee}${flags(node)}`;
  if (node.kind === "dynamic") return `? ${node.callee} (target only known at runtime)${flags(node)}`;
  if (node.kind === "callback") return `↩ ${node.callee} (runs a function passed in or returned)${flags(node)}`;
  const fact = inputs.functions.get(node.fn);
  const where = fact ? `${fact.file}:${fact.startLine}` : "";
  return `${mark}[${node.fn}] ${where} {${node.component}}${flags(node)}`;
}

/** `db .select() .from(chat)` → `db.select`: the call a chain starts with. */
function chainHead(callee: string): string {
  const flat = callee.replace(/\s+/g, "");
  const cut = flat.indexOf("(");
  return cut === -1 ? flat : flat.slice(0, cut);
}

/**
 * Indented text of the tree; noise is summarized per parent so the model sees what matters. Siblings that repeat a
 * function already listed under the same parent are dropped, and a parent's calls to one outside system share a line.
 */
export function renderTree(tree: CallTree, inputs: BriefInputs): string {
  const lines: string[] = [describe(tree.root, inputs)];
  const walk = (nodes: TreeNode[], depth: number): void => {
    let hidden = 0;
    const listed = new Set<string>();
    const systems = new Map<string, { heads: string[]; writes: boolean; line: number }>();
    for (const node of nodes) {
      if (node.importance === "noise") {
        hidden += 1;
        continue;
      }
      if (node.kind === "function") {
        if (listed.has(node.fn)) continue;
        listed.add(node.fn);
      }
      if (node.kind === "external" && node.system) {
        const group = systems.get(node.system);
        const head = chainHead(node.callee);
        if (group) {
          if (!group.heads.includes(head)) group.heads.push(head);
          group.writes ||= node.writes === true;
          continue;
        }
        systems.set(node.system, { heads: [head], writes: node.writes === true, line: lines.length });
      }
      lines.push(`${"  ".repeat(depth)}- ${describe(node, inputs)}`);
      if (node.kind === "function") walk(node.children, depth + 1);
    }
    for (const [system, group] of systems) {
      if (group.heads.length === 1 && lines[group.line]?.includes(`${system}: `)) continue;
      lines[group.line] = `${"  ".repeat(depth)}- ★ ⇢ ${system}: ${group.heads.join(", ")}${group.writes ? " [writes]" : ""}`;
    }
    if (hidden > 0) lines.push(`${"  ".repeat(depth)}- (+${hidden} minor helper${hidden === 1 ? "" : "s"})`);
  };
  walk(tree.root.children, 1);
  return lines.join("\n");
}

/** Function IDs shown in the brief (not noise), in tree order. */
export function visibleFunctions(tree: CallTree): string[] {
  const seen = new Set<string>();
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function" || node.importance === "noise") return;
    seen.add(node.fn);
    node.children.forEach(walk);
  };
  walk(tree.root);
  return [...seen];
}

/** Every function ID in the tree, noise included. */
export function treeFunctions(tree: CallTree): Set<string> {
  const seen = new Set<string>();
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    seen.add(node.fn);
    node.children.forEach(walk);
  };
  walk(tree.root);
  return seen;
}

/** Important function IDs: the ones a step must cover (D21). The root always counts. */
export function importantFunctions(tree: CallTree): string[] {
  const seen = new Set<string>([tree.root.fn]);
  const walk = (node: TreeNode): void => {
    if (node.kind !== "function") return;
    if (node.importance === "important") seen.add(node.fn);
    if (node.importance !== "noise") node.children.forEach(walk);
  };
  walk(tree.root);
  return [...seen];
}

/** Source of the root and important functions, trimmed. */
export function renderSnippets(tree: CallTree, inputs: BriefInputs): string {
  const parts: string[] = [];
  for (const id of importantFunctions(tree).slice(0, MAX_SNIPPETS)) {
    const fact = inputs.functions.get(id);
    const text = fact && inputs.readFile(fact.file);
    if (!fact || text === undefined) continue;
    const lines = text.split("\n").slice(fact.startLine - 1, fact.endLine);
    const shown = lines.slice(0, MAX_SNIPPET_LINES);
    const more = lines.length - shown.length;
    parts.push(`// [${id}] ${fact.file}:${fact.startLine}\n${shown.join("\n")}${more > 0 ? `\n// … ${more} more lines` : ""}`);
  }
  return parts.join("\n\n");
}
