import { useEffect, useMemo, useState } from "react";
import type { MapGraph, MapNode, TimelapseFrame, TimelapseView } from "../shared/types";
import { api } from "./api";
import { Canvas } from "./Canvas";
import { GraphView, Legend, NodeIcon } from "./GraphView";

const STEP_MS = 2600;

/** The step a frame stands for, as the Ask panel takes it (Build 8): the commits from the frame before to this one. */
export type TimelapseStep = { from: string; to: string; label: string };

type Props = { onStep: (step: TimelapseStep | null) => void };

const short = (sha: string): string => sha.slice(0, 7);

/** The union layout with this frame's boxes: present ones carry their status, ones that just left fade, the rest hide. */
function frameGraph(layout: MapGraph, frame: TimelapseFrame): { graph: MapGraph; status: Map<string, string> } {
  const present = new Map(frame.nodes.map((n) => [n.id, n]));
  const removed = new Set(frame.removed);
  const edges = new Set(frame.edges);
  const status = new Map<string, string>();
  const nodes: MapNode[] = layout.nodes.map((n) => {
    const now = present.get(n.id);
    status.set(n.id, now ? (now.status === "same" ? "" : now.status) : removed.has(n.id) ? "removed" : "hidden");
    return now ? { ...n, label: now.title, description: now.short } : n;
  });
  return { graph: { ...layout, nodes, edges: layout.edges.filter((e) => edges.has(e.id)) }, status };
}

function body(n: MapNode) {
  return (
    <>
      <span className="node-title"><NodeIcon kind={n.kind === "external" ? "external" : "part"} />{n.label}</span>
      <span className={n.kind === "external" ? "node-sub" : "node-text"}>{n.kind === "external" ? "outside system" : n.description}</span>
    </>
  );
}

/** Timelapse A → B (Build 9): play or scrub the checkpoints; boxes never move, they appear, change and fade. */
export function TimelapsePage({ onStep }: Props) {
  const [list, setList] = useState<{ from: string; to: string }[] | null>(null);
  const [view, setView] = useState<TimelapseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    api.timelapses().then(
      (all) => {
        setList(all);
        const last = all.at(-1);
        if (last) api.timelapse(last.from, last.to).then(setView, (e: unknown) => setError(String(e)));
      },
      (e: unknown) => setError(String(e)),
    );
  }, []);

  useEffect(() => {
    if (!playing || !view) return;
    if (index >= view.frames.length - 1) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setIndex((i) => i + 1), STEP_MS);
    return () => window.clearTimeout(t);
  }, [playing, index, view]);

  const frame = view?.frames[index];
  const prev = view && index > 0 ? view.frames[index - 1] : undefined;
  useEffect(() => {
    onStep(frame && prev ? { from: prev.sha, to: frame.sha, label: `${short(prev.sha)} → ${short(frame.sha)}` } : null);
  }, [frame, prev, onStep]);

  const drawn = useMemo(() => (view && frame ? frameGraph(view.layout, frame) : null), [view, frame]);

  if (error) return <div className="center-note">Could not load the timelapse: {error}</div>;
  if (!list) return <div className="center-note">Loading…</div>;
  if (list.length === 0 || !view || !frame || !drawn) {
    return list.length === 0 ? <div className="center-note">No timelapse yet; run: catchup timelapse &lt;path&gt;</div> : <div className="center-note">Loading…</div>;
  }
  const s = frame.step;
  return (
    <div className="timelapse">
      <div className="tl-stage">
        <div className="canvas-wrap">
          <Canvas width={view.layout.width} height={view.layout.height} fitKey={`${view.from}..${view.to}`}>
            <GraphView graph={drawn.graph} active={new Set()} selected={null} onSelect={() => undefined} body={body} statusOf={(id) => drawn.status.get(id) || undefined} />
          </Canvas>
          <Legend items={[{ label: "Part of the code", slot: 1 }, { label: "Outside system", slot: -1 }]} />
        </div>
        <div className="tl-controls">
          <button onClick={() => setIndex(0)} title="First">⏮</button>
          <button onClick={() => setIndex((i) => Math.max(0, i - 1))} title="Back">◀</button>
          <button
            className="primary"
            onClick={() => {
              if (index >= view.frames.length - 1) setIndex(0);
              setPlaying(!playing);
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button onClick={() => setIndex((i) => Math.min(view.frames.length - 1, i + 1))} title="Forward">▶</button>
          <button onClick={() => setIndex(view.frames.length - 1)} title="Last">⏭</button>
          <input
            type="range"
            min={0}
            max={view.frames.length - 1}
            value={index}
            onChange={(e) => {
              setPlaying(false);
              setIndex(Number(e.target.value));
            }}
          />
          <span className="mono small">{index + 1} / {view.frames.length}</span>
        </div>
      </div>
      <aside className="tl-side">
        <div className="kicker">{frame.date.slice(0, 10)} · {short(frame.sha)}{frame.tags.length ? ` · ${frame.tags.join(", ")}` : ""}</div>
        <div className="muted small">{frame.subject}</div>
        {s ? (
          <>
            <h2 className="tl-caption">{s.caption}</h2>
            <p>{s.impact}</p>
            <div className="chips cites">
              {s.commits.map((c) => (
                <span key={c.sha} className="chip mono commit" title={c.subject}>{short(c.sha)}</span>
              ))}
            </div>
            <ul className="facts tl-facts">
              <li className="add">{s.commitCount} commit{s.commitCount === 1 ? "" : "s"} · files +{s.files.added} ~{s.files.changed} −{s.files.removed}{s.files.renamed ? ` →${s.files.renamed}` : ""}</li>
              {s.entryPoints.added.slice(0, 4).map((e) => <li key={`+${e}`} className="add">new entry point <code>{e}</code></li>)}
              {s.entryPoints.added.length > 4 && <li className="add">+{s.entryPoints.added.length - 4} more entry points</li>}
              {s.entryPoints.removed.slice(0, 3).map((e) => <li key={`-${e}`} className="remove">entry point gone <code>{e}</code></li>)}
              {s.systems.added.map((x) => <li key={`+${x}`} className="add">now talks to <strong>{x}</strong></li>)}
              {s.systems.removed.map((x) => <li key={`-${x}`} className="remove">no longer talks to <strong>{x}</strong></li>)}
            </ul>
          </>
        ) : (
          <>
            <h2 className="tl-caption">Where it starts</h2>
            <p>{frame.summary}</p>
          </>
        )}
        {frame.journeys.length > 0 && (
          <>
            <div className="eyebrow">Main journeys at this point</div>
            {frame.journeys.map((j) => (
              <div key={j.title} className="tl-journey">
                <strong>{j.title}</strong>
                <ol>{j.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
              </div>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
