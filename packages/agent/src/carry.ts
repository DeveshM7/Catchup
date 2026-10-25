import { createHash } from "node:crypto";
import type { Flow, Step } from "./schemas.js";
import type { FlowOutput } from "./schemas.js";

export type FlowPlan =
  | { mode: "new" }
  | { mode: "carry"; flow: Flow }
  | { mode: "update"; previous: Flow; changed: string[]; added: string[]; removed: string[]; keepIds: Set<string> };

/**
 * Decides how much of a flow Claude must touch (ARCHITECTURE §6): nothing when no function in the
 * tree changed; otherwise only the steps citing a changed or removed function.
 */
export function planFlow(previous: Flow | undefined, basis: Record<string, string>): FlowPlan {
  if (!previous) return { mode: "new" };
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [id, hash] of Object.entries(basis)) {
    const before = previous.basis[id];
    if (before === undefined) added.push(id);
    else if (before !== hash) changed.push(id);
  }
  for (const id of Object.keys(previous.basis)) if (!(id in basis)) removed.push(id);
  if (changed.length + added.length + removed.length === 0) return { mode: "carry", flow: previous };
  const touched = new Set([...changed, ...removed]);
  const keepIds = new Set(previous.steps.filter((s) => !s.functions.some((fn) => touched.has(fn))).map((s) => s.id));
  return { mode: "update", previous, changed: changed.sort(), added: added.sort(), removed: removed.sort(), keepIds };
}

function newStepId(flowId: string, functions: string[]): string {
  const hash = createHash("sha256").update(`${flowId}\n${[...functions].sort().join("\n")}`).digest("hex").slice(0, 8);
  return `${flowId}#${hash}`;
}

/**
 * Builds the stored steps from Claude's output. Kept steps are copied verbatim from the previous
 * version (same id, label, text) whatever Claude wrote for them; new steps get a deterministic id.
 */
export function mergeSteps(flowId: string, output: FlowOutput, previous: Flow | undefined, keepIds: Set<string>): Step[] {
  const before = new Map((previous?.steps ?? []).map((s) => [s.id, s]));
  const used = new Set<string>();
  return output.steps.map((step) => {
    const old = step.id === null ? undefined : before.get(step.id);
    if (old && keepIds.has(old.id)) {
      used.add(old.id);
      return old;
    }
    let id = old ? old.id : newStepId(flowId, step.functions);
    for (let n = 2; used.has(id); n += 1) id = `${newStepId(flowId, step.functions)}~${n}`;
    used.add(id);
    return { id, label: step.label, summary: step.summary, functions: step.functions, kind: step.kind };
  });
}
