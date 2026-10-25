import { useEffect, useState, type ReactNode } from "react";
import type { MapGraph, MapNode, TreeData } from "../shared/types";
import { codeName, inScope, type Familiarity } from "../shared/view";
import { api } from "./api";
import { Canvas } from "./Canvas";
import { GraphView, Legend, NodeIcon } from "./GraphView";

type Scope = { files: Set<string>; systems: Set<string> };

type Props = {
  /** `root` (top parts) or a part id. */
  id: string;
  data: TreeData;
  mode: Familiarity;
  scope: Scope;
  /** Box id of the selection (`file:<path>` for files). */
  selected: string | null;
  onSelect: (box: string | null) => void;
  onOpen: (id: string) => void;
};

/** Files a box stands for, so a selection elsewhere can light it. */
export function boxFiles(box: string, data: TreeData): string[] {
  if (box.startsWith("file:")) return [box.slice("file:".length)];
  const node = data.nodes[box];
  return node?.kind === "part" ? node.files : [];
}

/** Box content by familiarity: Claude's title and short line, or code names and counts for experts. */
export const boxBody =
  (data: TreeData, mode: Familiarity) =>
  (n: MapNode): ReactNode => {
    if (n.kind === "file") {
      const name = n.label.split("/").pop() ?? n.label;
      const dir = n.label.slice(0, Math.max(0, n.label.length - name.length - 1));
      return (
        <>
          <span className="node-title"><NodeIcon kind="file" />{name}</span>
          <span className="node-sub">{dir || "."} · {n.functions} functions</span>
        </>
      );
    }
    const node = data.nodes[n.id];
    if (n.kind === "external" || !node) {
      return (
        <>
          <span className="node-title"><NodeIcon kind="external" />{n.label}</span>
          <span className="node-sub">{n.description.toLowerCase()}</span>
        </>
      );
    }
    const expert = mode === "expert";
    return (
      <>
        <span className="node-title"><NodeIcon kind="part" />{expert ? codeName(node, data) : node.title}</span>
        <span className={expert ? "node-sub" : "node-text"}>{expert ? `${n.files} files · ${n.functions} functions` : node.short}</span>
      </>
    );
  };

/** One architecture canvas: a node's children (or a leaf part's files) and the outside systems they call. */
export function ArchCanvas({ id, data, mode, scope, selected, onSelect, onOpen }: Props) {
  const [graph, setGraph] = useState<MapGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setGraph(null);
    setError(null);
    api.canvas(id).then(
      (g) => live && setGraph(g),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [id, data]);
  if (error) return <div className="center-note">Could not draw this level: {error}</div>;
  if (!graph) return <div className="center-note">Drawing…</div>;
  const onCanvas = selected !== null && graph.nodes.some((n) => n.id === selected);
  const active = onCanvas ? new Set<string>() : new Set(graph.nodes.filter((n) => inScope(scope, n.id, boxFiles(n.id, data))).map((n) => n.id));
  const files = graph.nodes.some((n) => n.kind === "file");
  return (
    <>
      <Canvas width={graph.width} height={graph.height} fitKey={id}>
        <GraphView
          graph={graph}
          active={active}
          selected={selected}
          onSelect={onSelect}
          body={boxBody(data, mode)}
          openable={(box) => data.nodes[box]?.kind === "part"}
          onOpen={onOpen}
        />
      </Canvas>
      <Legend
        items={[
          files ? { label: "File", slot: graph.nodes[0]?.color ?? 1 } : { label: "Part of the code", slot: 1 },
          ...[...new Set(graph.nodes.flatMap((n) => (n.kind === "external" ? [n.description] : [])))].map((label) => ({ label, slot: -1 })),
        ]}
      />
    </>
  );
}
