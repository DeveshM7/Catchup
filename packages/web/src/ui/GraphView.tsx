import type { ReactNode } from "react";
import type { MapGraph, MapNode } from "../shared/types";
import { Markers, markerId, roundedPath } from "./edges";
import { colorOf, cssVars } from "./theme";

type Props = {
  graph: MapGraph;
  /** Lit nodes; when non-empty everything else is dimmed. */
  active: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Box content; default: label and a size line. */
  body?: (node: MapNode) => ReactNode;
  /** Boxes that open into their own canvas get an open button (and open on double-click). */
  openable?: (id: string) => boolean;
  onOpen?: (id: string) => void;
  /** Extra mark per box (`st-<status>` class), e.g. what changed in the preview. */
  statusOf?: (id: string) => string | undefined;
};

const IMPORT = "#a3adbd";

export function NodeIcon({ kind }: { kind: MapNode["kind"] }) {
  if (kind === "external") {
    return (
      <svg className="icon" viewBox="0 0 16 16" aria-hidden>
        <ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (kind === "file") {
    return (
      <svg className="icon" viewBox="0 0 16 16" aria-hidden>
        <path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden>
      <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function defaultBody(node: MapNode): ReactNode {
  return (
    <>
      <span className="node-title"><NodeIcon kind={node.kind} />{node.label}</span>
      <span className="node-sub">{node.kind === "external" ? node.description.split(" (")[0]!.toLowerCase() : `${node.files} files`}</span>
    </>
  );
}

/** A graph canvas: our elkjs layout drawn as HTML boxes over SVG edges (D28). */
export function GraphView({ graph, active, selected, onSelect, body = defaultBody, openable, onOpen, statusOf }: Props) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lit = active.size > 0;
  const edges = graph.edges
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return null;
      const on = lit && active.has(edge.from) && active.has(edge.to);
      const touches = selected !== null && (edge.from === selected || edge.to === selected);
      if (!edge.points && !on && !touches) return null;
      const points = edge.points ?? [
        { x: from.x + from.width / 2, y: from.y + from.height / 2 },
        { x: to.x + to.width / 2, y: to.y + to.height / 2 },
      ];
      const color = on || touches ? (edge.kind === "uses" ? colorOf(-1).c : colorOf(from.color).c) : edge.kind === "uses" ? "#f0b48c" : IMPORT;
      const dim = (lit && !on) || (selected !== null && !touches && !lit);
      return { edge, points, color, dim, strong: on || touches };
    })
    .filter((e) => e !== null);
  return (
    <div className="graph" style={{ width: graph.width, height: graph.height }}>
      <svg className="edges" width={graph.width} height={graph.height}>
        <Markers colors={edges.map((e) => e.color)} />
        {edges.map(({ edge, points, color, dim, strong }) => (
          <path
            key={edge.id}
            d={roundedPath(points)}
            stroke={color}
            strokeWidth={strong ? 2 : 1.3}
            strokeDasharray={edge.kind === "uses" ? "5 4" : undefined}
            fill="none"
            opacity={dim ? 0.15 : strong ? 1 : 0.75}
            markerEnd={`url(#${markerId(color)})`}
          />
        ))}
      </svg>
      {graph.nodes.map((node) => {
        const dim = lit && !active.has(node.id);
        const opens = openable?.(node.id) === true && onOpen !== undefined;
        const status = statusOf?.(node.id);
        return (
          <div
            key={node.id}
            role="button"
            tabIndex={0}
            data-id={node.id}
            className={`node ${node.kind} ${dim ? "dim" : ""} ${lit && !dim ? "on" : ""} ${selected === node.id ? "selected" : ""} ${status ? `st-${status}` : ""}`}
            style={{ left: node.x, top: node.y, width: node.width, height: node.height, ...cssVars(node.color) }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(selected === node.id ? null : node.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (opens) onOpen(node.id);
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onSelect(selected === node.id ? null : node.id);
              }
            }}
            title={node.description}
          >
            {status && <span className={`st-badge ${status}`}>{status}</span>}
            {body(node)}
            {opens && (
              <button
                className="open-btn"
                title="Open: show what's inside"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(node.id);
                }}
              >
                ▸
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; slot: number; dashed?: boolean }[] }) {
  return (
    <div className="legend">
      <span className="legend-title">Legend</span>
      {items.map((item) => (
        <span key={item.label} className="legend-item" style={cssVars(item.slot)}>
          <span className={`swatch ${item.dashed ? "dashed" : ""}`} />
          {item.label}
        </span>
      ))}
    </div>
  );
}
