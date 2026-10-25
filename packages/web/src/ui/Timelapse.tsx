import { useEffect, useMemo, useState } from "react";
import type { MapNode, TimelapseView } from "../shared/types";
import { frameGraph, nodeBounds } from "../shared/timelapse";
import { api } from "./api";
import { Canvas, type Bounds } from "./Canvas";
import { GraphView, Legend, NodeIcon } from "./GraphView";

const STEP_MS = 2600;

/** The step a frame stands for, as the Ask panel takes it (Build 8): the commits from the frame before to this one. */
export type TimelapseStep = { from: string; to: string; label: string };

type Props = { onStep: (step: TimelapseStep | null) => void };

const short = (sha: string): string => sha.slice(0, 7);

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
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<Bounds | undefined>();

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

  const drawn = useMemo(() => (view && frame ? frameGraph(view.layout, frame, prev) : null), [view, frame, prev]);

  if (error) return <div className="center-note">Could not load the timelapse: {error}</div>;
  if (!list) return <div className="center-note">Loading…</div>;
  if (list.length === 0 || !view || !frame || !drawn) {
    return list.length === 0 ? <div className="center-note">No timelapse yet; run: catchup timelapse &lt;path&gt;</div> : <div className="center-note">Loading…</div>;
  }
  const s = frame.step;
  const selectedNode = drawn.graph.nodes.find((n) => n.id === selected);
  return (
    <div className="timelapse">
      <div className="tl-stage">
        <div className="tl-toolbar">
          <button className="ghost small" onClick={() => setFocus(nodeBounds(drawn.graph.nodes))}>Fit this frame</button>
          <button className="ghost small" onClick={() => setFocus(undefined)}>Fit all history</button>
          <span className="muted small">Fixed box positions · click a box for details</span>
        </div>
        <div className="canvas-wrap">
          <Canvas width={view.layout.width} height={view.layout.height} fitKey={`${view.from}..${view.to}`} {...(focus ? { fitBounds: focus } : {})}>
            <GraphView graph={drawn.graph} active={new Set()} selected={selectedNode?.id ?? null} onSelect={setSelected} body={body} statusOf={(id) => drawn.status.get(id) || undefined} />
          </Canvas>
          <Legend items={[{ label: "Part of the code", slot: 1 }, { label: "Outside system", slot: -1 }]} />
        </div>
        <div className="tl-controls">
          <button onClick={() => { setPlaying(false); setIndex(0); }} title="First" disabled={index === 0}>⏮</button>
          <button onClick={() => { setPlaying(false); setIndex((i) => Math.max(0, i - 1)); }} title="Back" disabled={index === 0}>◀</button>
          <button
            className="primary"
            onClick={() => {
              if (index >= view.frames.length - 1) setIndex(0);
              if (!playing) setFocus(undefined);
              setPlaying(!playing);
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button onClick={() => { setPlaying(false); setIndex((i) => Math.min(view.frames.length - 1, i + 1)); }} title="Forward" disabled={index === view.frames.length - 1}>▶</button>
          <button onClick={() => { setPlaying(false); setIndex(view.frames.length - 1); }} title="Last" disabled={index === view.frames.length - 1}>⏭</button>
          <input
            type="range"
            aria-label="Timelapse checkpoint"
            aria-valuetext={`${frame.date.slice(0, 10)}, ${short(frame.sha)}`}
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
      <aside className="tl-side" aria-label="Checkpoint details">
        <h1>Timelapse</h1>
        <div className="kicker">{frame.date.slice(0, 10)} · {short(frame.sha)}{frame.tags.length ? ` · ${frame.tags.join(", ")}` : ""}</div>
        <div className="muted small">{frame.subject}</div>
        {selectedNode && (
          <section className="tl-selected">
            <h2>{selectedNode.label}</h2>
            <p>{selectedNode.description}</p>
            {drawn.status.get(selectedNode.id) === "removed" && <p className="muted small">Removed since the previous checkpoint.</p>}
            <button className="link-text small" onClick={() => setFocus(nodeBounds([selectedNode]))}>Zoom to this box</button>
          </section>
        )}
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
        <div className="eyebrow">Boxes in this frame</div>
        <div className="tl-boxes">
          {frame.nodes.map((n) => (
            <button key={n.id} className={`link-text ${n.id === selected ? "strong" : ""}`} onClick={() => setSelected(n.id)}>{n.title}</button>
          ))}
        </div>
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
