import { FLOW, flowLayout } from "../shared/flowLayout";
import type { NodeView, TreeData } from "../shared/types";
import { canOpen, codeName, compactStep, inScope, visibleChildren, type Familiarity, type Scope } from "../shared/view";
import { Canvas } from "./Canvas";
import { Markers, markerId, roundedPath } from "./edges";
import { Legend, NodeIcon } from "./GraphView";
import { cssVars, pad2 } from "./theme";


type Props = {
  /** A journey or a step with sub-steps. */
  parent: NodeView;
  data: TreeData;
  mode: Familiarity;
  scope: Scope;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
};

const EDGE = { main: "#0f9f87", check: "#0f9f87", error: "#d94a72", branch: "#d9821a" } as const;
const TAG = { error: "error path", branch: "sometimes", check: "check" } as const;

export const systemName = (id: string, data: TreeData): string => data.nodes[id]?.title ?? id.replace(/^system:/, "");

/** A journey's steps left to right, one lane per top part, outside systems in the last row. */
export function StepsCanvas({ parent, data, mode, scope, selected, onSelect, onOpen }: Props) {
  const { shown, hidden } = visibleChildren(parent, data, mode);
  const layout = flowLayout(shown.map((s) => ({ id: s.id, lane: s.lane ?? "none", systems: s.systems, kind: s.stepKind ?? "main" })));
  const lit = scope.files.size > 0 || scope.systems.size > 0;
  const onCanvas = selected !== null && shown.some((s) => s.id === selected);
  const laneName = (id: string): string => {
    const part = data.nodes[id];
    if (!part) return "Other code";
    return mode === "expert" ? codeName(part, data) : part.title;
  };
  return (
    <>
      <Canvas width={layout.width} height={layout.height} fitKey={parent.id}>
        <div className="flow-diagram" style={{ width: layout.width, height: layout.height }}>
          {layout.lanes.map((lane) => (
            <div
              key={lane.id}
              className={`lane ${lane.kind}`}
              style={{ left: lane.x, top: lane.y, width: lane.width, height: lane.height, ...cssVars(lane.kind === "systems" ? -1 : (data.nodes[lane.id]?.color ?? 7)) }}
            >
              {lane.kind === "systems" ? (
                <span className="lane-title">Outside systems and tools</span>
              ) : (
                <button
                  className="lane-title"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (data.nodes[lane.id]) onSelect(lane.id);
                  }}
                >
                  {pad2(lane.index + 1)} / {laneName(lane.id)}
                </button>
              )}
            </div>
          ))}
          <svg className="edges" width={layout.width} height={layout.height}>
            <Markers colors={Object.values(EDGE)} />
            {layout.edges.map((edge) => (
              <path
                key={edge.id}
                d={roundedPath(edge.points)}
                stroke={EDGE[edge.kind]}
                strokeWidth={1.8}
                strokeDasharray={edge.kind === "error" || edge.kind === "branch" ? "6 4" : undefined}
                fill="none"
                markerEnd={`url(#${markerId(EDGE[edge.kind])})`}
              />
            ))}
          </svg>
          {layout.steps.map((box) => {
            const step = data.nodes[box.id];
            if (!step) return null;
            const kind = step.stepKind ?? "main";
            const compact = compactStep(step, mode);
            const opens = canOpen(step);
            const on = lit && !onCanvas && inScope(scope, step.id, step.files);
            const cited = scope.nodes?.has(step.id) === true;
            const dim = lit && !onCanvas && !on;
            return (
              <div
                key={box.id}
                role="button"
                tabIndex={0}
                data-id={step.id}
                className={`step-box ${kind} ${compact ? "compact" : ""} ${step.systems.length ? "has-chips" : ""} ${selected === step.id ? "selected" : ""} ${dim ? "dim" : ""} ${on ? "lit" : ""} ${cited ? "cited" : ""}`}
                style={{ left: box.x, top: box.y, width: box.width, height: box.height, ...cssVars(step.color), ["--i" as string]: box.index }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(selected === step.id ? null : step.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (opens) onOpen(step.id);
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelect(step.id);
                  }
                }}
              >
                <span className="step-top">
                  <span className="step-num">{box.index + 1}</span>
                  {kind !== "main" && <span className={`tag ${kind}`}>{TAG[kind]}</span>}
                </span>
                <span className={`step-title ${mode === "expert" ? "mono" : ""}`}>{mode === "expert" ? codeName(step, data) : step.title}</span>
                {!compact && mode !== "expert" && <span className="step-text">{step.short}</span>}
                {!compact && mode === "expert" && <span className="step-sub">{step.files.map((f) => f.split("/").pop()).slice(0, 2).join(", ")}</span>}
                {!compact && step.systems.length > 0 && (
                  <span className="chips">
                    {step.systems.slice(0, FLOW.maxChips).map((s) => (
                      <span key={s} className="chip system">{systemName(s, data)}</span>
                    ))}
                    {step.systems.length > FLOW.maxChips && <span className="chip">+{step.systems.length - FLOW.maxChips}</span>}
                  </span>
                )}
                {opens && (
                  <button
                    className="open-btn"
                    title="Open: show the sub-steps"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(step.id);
                    }}
                  >
                    ▸
                  </button>
                )}
              </div>
            );
          })}
          {layout.systems.map((box) => {
            const users = shown.flatMap((s, i) => (s.systems.includes(box.id) ? [i + 1] : []));
            const on = lit && scope.systems.has(box.id);
            return (
              <div
                key={box.id}
                role="button"
                tabIndex={0}
                className={`node external flow-system ${selected === box.id ? "selected" : ""} ${lit && !on && !onCanvas ? "dim" : ""}`}
                style={{ left: box.x, top: box.y, width: box.width, height: box.height, ...cssVars(-1) }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (data.nodes[box.id]) onSelect(box.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (data.nodes[box.id]) onSelect(box.id);
                  }
                }}
              >
                <span className="node-title"><NodeIcon kind="external" />{systemName(box.id, data)}</span>
                <span className="node-sub">step{users.length > 1 ? "s" : ""} {users.join(", ")}</span>
              </div>
            );
          })}
        </div>
      </Canvas>
      <Legend items={legend(shown, data, laneName)} />
      {hidden > 0 && <div className="hint">{hidden} error path{hidden === 1 ? "" : "s"} hidden · switch to Familiar or Expert to see {hidden === 1 ? "it" : "them"}</div>}
    </>
  );
}

function legend(steps: NodeView[], data: TreeData, laneName: (id: string) => string): { label: string; slot: number; dashed?: boolean }[] {
  const lanes = [...new Set(steps.map((s) => s.lane ?? "none"))];
  return [
    ...lanes.map((id) => ({ label: laneName(id), slot: data.nodes[id]?.color ?? 7 })),
    ...(steps.some((s) => s.systems.length) ? [{ label: steps.some((s) => s.systems.some((id) => data.nodes[id]?.short.startsWith("Outside tool"))) ? "Outside system or tool" : "Outside system", slot: -1 }] : []),
    ...(steps.some((s) => s.stepKind === "error") ? [{ label: "Error path", slot: 3, dashed: true }] : []),
    ...(steps.some((s) => s.stepKind === "branch") ? [{ label: "Only sometimes", slot: 4, dashed: true }] : []),
  ];
}
