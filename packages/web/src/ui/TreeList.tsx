import { useState } from "react";
import type { FunctionRef, TreeNodeView } from "../shared/types";

type Props = { nodes: TreeNodeView[]; showNoise: boolean; onOpen: (fn: FunctionRef) => void; depth?: number };

const ICON = { external: "⇢", dynamic: "?", callback: "↩" } as const;

function Row({ node, count, showNoise, onOpen, depth }: { node: TreeNodeView; count: number; showNoise: boolean; onOpen: (fn: FunctionRef) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const shownFlags = count > 1 ? node.flags.filter((f) => f !== "shown above") : node.flags;
  const flags = shownFlags.length ? <span className="flags">{shownFlags.join(" · ")}</span> : null;
  const times = count > 1 ? <span className="times">×{count}</span> : null;
  if (node.kind !== "function") {
    return (
      <li className={`tree-row ${node.importance} ${node.kind}`}>
        <span className="twisty" />
        <span className="icon">{ICON[node.kind]}</span> {node.label} {times} {flags}
      </li>
    );
  }
  const children = showNoise ? node.children : node.children.filter((c) => c.importance !== "noise");
  return (
    <li className={`tree-row ${node.importance}`}>
      <button className="twisty" onClick={() => setOpen(!open)} disabled={children.length === 0}>
        {children.length === 0 ? "" : open ? "▾" : "▸"}
      </button>
      <button className="fn-link" onClick={() => onOpen(node.fn)} title={`${node.fn.file}:${node.fn.startLine}`}>
        {node.importance === "important" ? "★ " : ""}
        {node.fn.name}
      </button>
      <span className="where">{node.fn.component}</span> {times} {flags}
      {open && children.length > 0 && <TreeList nodes={children} showNoise={showNoise} onOpen={onOpen} depth={depth + 1} />}
    </li>
  );
}

export function TreeList({ nodes, showNoise, onOpen, depth = 0 }: Props) {
  const shown = mergeRepeats(showNoise ? nodes : nodes.filter((n) => n.importance !== "noise"));
  const hidden = nodes.length - shown.reduce((sum, row) => sum + row.count, 0);
  return (
    <ul className="tree">
      {shown.map(({ node, count }, i) => (
        <Row key={`${i}-${rowKey(node)}`} node={node} count={count} showNoise={showNoise} onOpen={onOpen} depth={depth} />
      ))}
      {hidden > 0 && <li className="tree-row hidden-note">+{hidden} minor helper{hidden === 1 ? "" : "s"}</li>}
    </ul>
  );
}

function rowKey(node: TreeNodeView): string {
  return node.kind === "function" ? node.fn.id : `${node.kind}:${node.label}`;
}

/** Sibling calls with nothing new below them (repeats, leaves) collapse into the first one, with a count. */
function mergeRepeats(nodes: TreeNodeView[]): { node: TreeNodeView; count: number }[] {
  const rows: { node: TreeNodeView; count: number }[] = [];
  const firstOf = new Map<string, { node: TreeNodeView; count: number }>();
  for (const node of nodes) {
    const leaf = node.kind !== "function" || node.children.length === 0;
    const key = rowKey(node);
    const first = firstOf.get(key);
    if (first && leaf) {
      first.count += 1;
      continue;
    }
    const row = { node, count: 1 };
    rows.push(row);
    if (!firstOf.has(key)) firstOf.set(key, row);
  }
  return rows;
}
