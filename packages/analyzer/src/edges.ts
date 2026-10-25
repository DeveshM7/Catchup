import { PKG_PREFIX, type ImportFact } from "./facts.js";
import type { ComponentEdge } from "./snapshot.js";
import { compareImports } from "./sort.js";

/** File imports rolled up to component → component edges, weighted by import count. */
export function rollUpEdges(imports: ImportFact[], componentOf: Map<string, string>): ComponentEdge[] {
  const weights = new Map<string, ComponentEdge>();
  for (const { from, to } of imports) {
    if (to.startsWith(PKG_PREFIX)) continue;
    const a = componentOf.get(from);
    const b = componentOf.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}\0${b}`;
    const edge = weights.get(key) ?? { from: a, to: b, weight: 0 };
    edge.weight += 1;
    weights.set(key, edge);
  }
  return [...weights.values()].sort(compareImports);
}

/** component id → package names it imports. */
export function packagesByComponent(imports: ImportFact[], componentOf: Map<string, string>): Map<string, Set<string>> {
  const byComponent = new Map<string, Set<string>>();
  for (const { from, to } of imports) {
    if (!to.startsWith(PKG_PREFIX)) continue;
    const component = componentOf.get(from);
    if (component === undefined) continue;
    const set = byComponent.get(component) ?? new Set<string>();
    set.add(to.slice(PKG_PREFIX.length));
    byComponent.set(component, set);
  }
  return byComponent;
}
