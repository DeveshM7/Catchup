import type { FunctionFact } from "./facts.js";
import type { CallTree, FunctionTreeNode, Importance, TreeNode } from "./calltree.js";

/** Last name segment that marks logging, validation and type-guard helpers. */
const NOISE_NAME = /^(log|logger|debug|trace|warn|info|assert|invariant|validate|isValid|format|noop)(?![a-z])|^(is|has)[A-Z]/;
const TINY_LINES = 5;

export type ScoringInputs = { functions: Map<string, FunctionFact> };

function lastSegment(fn: string): string {
  const name = fn.slice(fn.indexOf("#") + 1);
  return name.split(".").at(-1) ?? name;
}

function isSystemCall(node: TreeNode): boolean {
  return node.kind === "external" && node.system !== undefined;
}

/**
 * Marks each node important / normal / noise (D21). Noise is never removed.
 * Important: crosses a component boundary, calls an external system directly, or is reached across the client/server
 * boundary (a request or a streamed message) or as an AI tool.
 * Noise: logging/validation/type-guard names, error-only calls, tiny leaf helpers, non-system packages.
 */
function score(node: TreeNode, parent: FunctionTreeNode | undefined, inputs: ScoringInputs): Importance {
  if (node.kind === "external") return node.system ? "important" : "noise";
  if (node.kind === "dynamic") return node.site.onError ? "noise" : "normal";
  if (node.kind === "callback") return "noise"; // its steps are scored where the function is defined
  for (const child of node.children) child.importance = score(child, node, inputs);
  if (node.site?.onError) return "noise";
  if (node.site?.remote || node.site?.message || node.site?.tool) return "important";
  if (NOISE_NAME.test(lastSegment(node.fn))) return "noise";
  const crosses = parent !== undefined && parent.component !== node.component;
  const touchesSystem = node.children.some(isSystemCall);
  if (touchesSystem) return "important";
  const fact = inputs.functions.get(node.fn);
  const lines = fact ? fact.endLine - fact.startLine + 1 : Number.POSITIVE_INFINITY;
  const hasWork = node.children.some((c) => c.kind === "function" || c.kind === "dynamic");
  if ((node.stop === "repeat" || !hasWork) && lines <= TINY_LINES) return "noise";
  return crosses ? "important" : "normal";
}

export function scoreTree(tree: CallTree, inputs: ScoringInputs): CallTree {
  tree.root.importance = score(tree.root, undefined, inputs);
  if (tree.root.importance === "noise") tree.root.importance = "normal";
  return tree;
}
