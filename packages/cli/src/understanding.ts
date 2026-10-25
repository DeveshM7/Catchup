import type { Understanding, UnderstandingNode } from "@catchup/agent";

function childrenOf(u: Understanding, node: UnderstandingNode): UnderstandingNode[] {
  return Array.isArray(node.children) ? node.children.flatMap((id) => (u.nodes[id] ? [u.nodes[id]] : [])) : [];
}

const more = (node: UnderstandingNode): string => (node.children === "unopened" ? "  (+ open)" : "");

function partLines(u: Understanding, node: UnderstandingNode, depth: number): string[] {
  const pad = "  ".repeat(depth);
  return [
    `${pad}- ${node.title} — ${node.short}  [${node.id}, ${node.anchor.files.length} files]${more(node)}`,
    ...childrenOf(u, node).flatMap((child) => partLines(u, child, depth + 1)),
  ];
}

function stepLines(u: Understanding, node: UnderstandingNode, depth: number, index: number): string[] {
  const pad = "  ".repeat(depth);
  const kind = node.stepKind && node.stepKind !== "main" ? ` [${node.stepKind}]` : "";
  const systems = node.systems?.length ? `  ⇢ ${node.systems.join(", ")}` : "";
  return [
    `${pad}${index}.${kind} ${node.title} — ${node.short}${systems}${more(node)}`,
    `${pad}   ${node.anchor.functions.join(", ")}`,
    ...childrenOf(u, node).flatMap((child, i) => stepLines(u, child, depth + 1, i + 1)),
  ];
}

const cites = (c: { files: string[]; functions: string[] }): string => [...c.files, ...c.functions].join(", ");

/** Text view of the understanding tree (Build 2; the zoomable view is Build 3). */
export function formatUnderstanding(u: Understanding): string {
  const lines = [u.summary, "", "Parts:"];
  for (const id of u.parts) if (u.nodes[id]) lines.push(...partLines(u, u.nodes[id], 1));
  lines.push("", `Outside systems: ${u.systems.map((id) => u.nodes[id]?.title ?? id).join(", ") || "none"}`, "", "Main journeys:");
  for (const id of u.journeys) {
    const journey = u.nodes[id];
    if (!journey) continue;
    lines.push(`  ${journey.title} — ${journey.short}  [${journey.entry}]${more(journey)}`);
    childrenOf(u, journey).forEach((step, i) => lines.push(...stepLines(u, step, 2, i + 1)));
  }
  lines.push("", "Other flows:", ...u.otherFlows.map((f) => `  - ${f.label}${f.members > 1 ? ` (+${f.members - 1} like it)` : ""} — ${f.line}`));
  const extras = u.extras;
  if (extras) {
    lines.push("", "Key ideas:", ...extras.glossary.map((g) => `  - ${g.term}: ${g.meaning}  (${cites(g)})`));
    lines.push("", "Start here:", ...extras.startHere.map((s, i) => `  ${i + 1}. ${s.file} — ${s.why}`));
    lines.push("", "Where to change things:", ...extras.changes.map((c) => `  - ${c.task}: ${cites(c)}`));
    if (extras.surprises.length) lines.push("", "Surprises:", ...extras.surprises.map((s) => `  - ${s.text}  (${cites(s)})`));
  }
  return lines.join("\n");
}
