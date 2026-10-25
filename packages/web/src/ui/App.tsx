import { useCallback, useEffect, useState } from "react";
import type { MapData, TreeData } from "../shared/types";
import { answerScope, FAMILIARITIES, canOpen, codeName, panelText, pathTo, selectionScope, type Familiarity, type Selection } from "../shared/view";
import { api } from "./api";
import { ArchCanvas } from "./ArchCanvas";
import { AskPanel, type Turn } from "./AskPanel";
import { Canvas } from "./Canvas";
import { GraphView, Legend } from "./GraphView";
import { Home } from "./Home";
import { entryName, MethodLabel, Prose } from "./labels";
import { Panel } from "./panels";
import { changeCount, PreviewPage, usePreview } from "./Preview";
import { TimelapsePage, type TimelapseStep } from "./Timelapse";
import { formatRoute, parseRoute, type Route } from "./route";
import { Search } from "./Search";
import { StepsCanvas } from "./StepsCanvas";
import { cssVars } from "./theme";

const MODE_KEY = "catchup.familiarity";
const MODE_LABEL: Record<Familiarity, string> = { new: "New", familiar: "Familiar", expert: "Expert" };
const MODE_HINT: Record<Familiarity, string> = {
  new: "Full explanations, error paths hidden.",
  familiar: "Short lines, checks folded.",
  expert: "Code names only, every path shown.",
};

function loadMode(): Familiarity {
  const saved = window.localStorage.getItem(MODE_KEY);
  return FAMILIARITIES.find((f) => f === saved) ?? "new";
}

/** The route lives in the URL hash; experts start at the architecture, everyone else at home (D40). */
function useRoute(mode: Familiarity): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash) ?? (mode === "expert" ? { view: "arch", id: "root" } : { view: "home" }));
  useEffect(() => {
    const onHash = (): void => {
      const next = parseRoute(window.location.hash);
      if (next) setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((r: Route) => {
    const hash = formatRoute(r);
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(r);
  }, []);
  return [route, go];
}

type Opening = { id: string; title: string; started: number };

export function App() {
  const [data, setData] = useState<TreeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<Familiarity>(loadMode);
  const [route, go] = useRoute(mode);
  const [stack, setStack] = useState<Selection[]>([]);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [asking, setAsking] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [about, setAbout] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; at: number } | null>(null);
  const [litTurn, setLitTurn] = useState<Turn | null>(null);
  const preview = usePreview(route.view === "preview");
  const [previewLevel, setPreviewLevel] = useState("root");
  const [hasTimelapse, setHasTimelapse] = useState(false);
  const [timelapseStep, setTimelapseStep] = useState<TimelapseStep | null>(null);
  useEffect(() => {
    api.timelapses().then((all) => setHasTimelapse(all.length > 0), () => setHasTimelapse(false));
  }, []);

  useEffect(() => {
    api.understanding().then(setData, (e: unknown) => setError(String(e)));
  }, []);

  const setMode = (m: Familiarity): void => {
    window.localStorage.setItem(MODE_KEY, m);
    setModeState(m);
  };

  if (error) return <div className="center">Could not load the understanding: {error}</div>;
  if (!data) return <div className="center">Loading…</div>;

  const sel = stack.at(-1);
  // On the Preview tab the detail panel shows the working tree: new files and boxes, and source as saved.
  const onPreview = route.view === "preview" && Boolean(preview?.tree);
  const currentData = onPreview && preview?.tree ? preview.tree : data;
  // Removed citations still resolve against HEAD; new ones resolve against the working tree.
  const panelData = sel && (sel.kind === "fn" ? !currentData.refs[sel.id] : sel.kind === "file" ? !currentData.files[sel.path] : sel.kind === "node" ? !currentData.nodes[sel.id] : false) ? data : currentData;
  const citationData = onPreview ? { ...currentData, nodes: { ...data.nodes, ...currentData.nodes }, refs: { ...data.refs, ...currentData.refs }, files: { ...data.files, ...currentData.files } } : data;
  // A selected box wins; otherwise the answer last lit shows what it cites (Build 5).
  const scope = sel || !litTurn?.reply ? selectionScope(sel, panelData) : answerScope(litTurn.reply, citationData);
  const askAbout = (id: string | null): void => {
    setAbout(id);
    setAsking(true);
  };
  /** From a canvas or list: starts a fresh panel. */
  const select = (next: Selection | null): void => setStack(next ? [next] : []);
  /** From inside the panel: Back returns to where it was. */
  const push = (next: Selection): void => setStack((s) => [...s, next]);
  const selectedBox = sel?.kind === "node" ? sel.id : sel?.kind === "file" ? `file:${sel.path}` : null;

  const targetOf = (id: string): Route => (data.nodes[id]?.kind === "part" ? { view: "arch", id } : { view: "flows", id });
  const open = async (id: string): Promise<void> => {
    if (onPreview && currentData.nodes[id]?.kind === "part") {
      setPreviewLevel(id);
      return;
    }
    const node = data.nodes[id];
    if (!node || !canOpen(node) || opening) return;
    if (node.children !== "unopened") return go(targetOf(id));
    setOpenError(null);
    setOpening({ id, title: node.title, started: Date.now() });
    try {
      setData(await api.open(id));
      go(targetOf(id));
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  const name = (id: string): string => {
    const node = data.nodes[id];
    if (!node) return id;
    return mode === "expert" ? (node.kind === "journey" ? entryName(node.entry ?? id, data).name : codeName(node, data)) : node.title;
  };
  const flowNode = route.view === "flows" ? (data.nodes[route.id] ?? data.nodes[data.journeys[0] ?? ""]) : undefined;
  const flowParent = flowNode && Array.isArray(flowNode.children) ? flowNode : flowNode?.parent ? data.nodes[flowNode.parent] : undefined;
  const crumbs: { label: string; go: () => void }[] =
    route.view === "arch"
      ? [{ label: "Architecture", go: () => go({ view: "arch", id: "root" }) }, ...(route.id === "root" ? [] : pathTo(route.id, data)).map((n) => ({ label: name(n.id), go: () => go({ view: "arch", id: n.id }) }))]
      : route.view === "flows"
        ? [{ label: "Flows", go: () => go({ view: "flows", id: data.journeys[0] ?? "" }) }, ...(flowParent ? pathTo(flowParent.id, data) : []).map((n) => ({ label: name(n.id), go: () => go({ view: "flows", id: n.id }) }))]
        : [];

  const tab = (view: Route["view"], label: string, to: Route) => (
    <button className={route.view === view ? "active" : ""} onClick={() => go(to)}>{label}</button>
  );

  return (
    <div className={`app ${asking ? "asking" : ""} ${sel ? "has-detail" : ""}`}>
      <aside className="sidebar" aria-label="Repository navigation">
        <button className="brand" onClick={() => go({ view: "home" })}>
          <span className="logo">◆</span> Catchup
        </button>
        <div className="repo">{data.repo} <span className="mono muted">@{data.sha.slice(0, 7)}</span></div>
        <div className="familiarity">
          <div className="side-label">How well do you know this code?</div>
          <div className="views">
            {FAMILIARITIES.map((m) => (
              <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
            ))}
          </div>
          <div className="side-hint">{MODE_HINT[mode]}</div>
        </div>
        <section className="side-area">
          <div className="side-area-name">Journeys</div>
          {data.journeys.map((id) => (
            <button key={id} className={`side-flow ${flowParent?.id === id ? "active" : ""}`} style={cssVars(data.nodes[id]?.color ?? 0)} onClick={() => go({ view: "flows", id })}>
              {name(id)}
            </button>
          ))}
        </section>
        <section className="side-area">
          <div className="side-area-name">Parts</div>
          {data.parts.map((id) => (
            <button key={id} className={`side-flow ${route.view === "arch" && route.id === id ? "active" : ""}`} style={cssVars(data.nodes[id]?.color ?? 0)} onClick={() => open(id)}>
              <span className="dot" />{name(id)}
            </button>
          ))}
        </section>
        <section className="side-area">
          <button className="side-area-name link" onClick={() => setShowOther(!showOther)}>
            {showOther ? "▾" : "▸"} Other flows · {data.otherFlows.length}
          </button>
          {showOther &&
            data.otherFlows.map((f) => (
              <button key={f.entry} className={`side-flow small ${sel?.kind === "entry" && sel.id === f.entry ? "active" : ""}`} onClick={() => select({ kind: "entry", id: f.entry })} title={mode === "expert" ? f.entry : f.line}>
                <MethodLabel label={f.label} />
              </button>
            ))}
        </section>
        <div className="side-foot">Explained by {data.model}</div>
      </aside>

      <main className="main">
        <div className="topbar">
          <nav className="tabs">
            {tab("home", "Home", { view: "home" })}
            {tab("arch", "Architecture", { view: "arch", id: route.view === "arch" ? route.id : "root" })}
            {tab("flows", "Flows", { view: "flows", id: flowParent?.id ?? data.journeys[0] ?? "" })}
            {tab("map", "Full map", { view: "map" })}
            {hasTimelapse && tab("timelapse", "Timelapse", { view: "timelapse" })}
            {preview && preview.status !== "off" && (
              <button className={route.view === "preview" ? "active" : ""} onClick={() => go({ view: "preview" })}>
                Preview{changeCount(preview.changes) > 0 && <span className="badge">{changeCount(preview.changes)}</span>}
              </button>
            )}
          </nav>
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={i} className="crumb-wrap">
                {i > 0 && <span className="sep">/</span>}
                <button className={`crumb ${i === crumbs.length - 1 ? "last" : ""}`} onClick={c.go}>{c.label}</button>
              </span>
            ))}
          </div>
          <Search data={currentData} onPick={select} />
          <button className={`ghost ask-toggle ${asking ? "active" : ""}`} onClick={() => setAsking(!asking)}>Ask</button>
        </div>

        {opening && <OpeningNote opening={opening} />}
        {openError && (
          <div className="banner error">
            Could not open: {openError} <button className="close" onClick={() => setOpenError(null)}>×</button>
          </div>
        )}

        {route.view === "home" && (
          <Home data={data} mode={mode} scope={scope} selected={selectedBox} onSelect={select} onOpen={open} onFlow={(id) => go({ view: "flows", id })} onArch={() => go({ view: "arch", id: "root" })} />
        )}

        {route.view === "arch" && (
          <div className="canvas-view" onClick={() => select(null)}>
            <LevelHead id={route.id} data={data} mode={mode} />
            <div className="canvas-wrap">
              <ArchCanvas
                id={route.id}
                data={data}
                mode={mode}
                scope={scope}
                selected={selectedBox}
                onSelect={(box) => select(!box ? null : box.startsWith("file:") ? { kind: "file", path: box.slice("file:".length) } : data.nodes[box] ? { kind: "node", id: box } : null)}
                onOpen={open}
              />
            </div>
          </div>
        )}

        {route.view === "flows" && flowParent && (
          <div className="canvas-view" onClick={() => select(null)}>
            <LevelHead id={flowParent.id} data={data} mode={mode} />
            <div className="canvas-wrap">
              <StepsCanvas
                parent={flowParent}
                data={data}
                mode={mode}
                scope={scope}
                selected={sel?.kind === "node" ? sel.id : null}
                onSelect={(id) => select(id ? { kind: "node", id } : null)}
                onOpen={open}
              />
            </div>
          </div>
        )}
        {route.view === "flows" && !flowParent && (
          <div className="center-note">No main journeys in this snapshot. Explore Architecture or the other flows in the sidebar.</div>
        )}

        {route.view === "map" && <FullMap />}

        {route.view === "preview" && (
          <PreviewPage
            level={previewLevel}
            onOpen={setPreviewLevel}
            scope={scope}
            view={preview}
            mode={mode}
            selected={selectedBox}
            onSelect={select}
            onAsk={(text) => {
              setAbout(null);
              setDraft(text ? { text, at: Date.now() } : null);
              setAsking(true);
            }}
          />
        )}

        {route.view === "timelapse" && <TimelapsePage onStep={setTimelapseStep} />}
      </main>

      {sel && (
        <aside className="detail" aria-label="Code details">
          <div className="panel-bar">
            {stack.length > 1 ? <button className="link-text" onClick={() => setStack((s) => s.slice(0, -1))}>← Back</button> : <span />}
            <button className="close" onClick={() => select(null)} title="Close">×</button>
          </div>
          <Panel sel={sel} data={panelData} mode={mode} onSelect={push} onOpen={open} onAsk={askAbout} {...(onPreview && panelData === currentData ? { previewVersion: preview?.updatedAt ?? "" } : {})} />
        </aside>
      )}

      {asking && (
        <AskPanel
          data={citationData}
          mode={mode}
          turns={turns}
          setTurns={setTurns}
          about={about}
          onAbout={setAbout}
          lit={litTurn?.id ?? null}
          onLight={(turn) => {
            setLitTurn(turn);
            setStack([]);
          }}
          onSelect={select}
          draft={draft}
          onClose={() => {
            setAsking(false);
            setLitTurn(null);
          }}
          change={
            route.view === "preview" && preview?.changes
              ? { request: "preview", label: "uncommitted changes" }
              : route.view === "timelapse" && timelapseStep
                ? { request: { from: timelapseStep.from, to: timelapseStep.to }, label: timelapseStep.label }
                : null
          }
        />
      )}
    </div>
  );
}

/** Title and text of the node whose children the canvas shows. */
function LevelHead({ id, data, mode }: { id: string; data: TreeData; mode: Familiarity }) {
  const node = data.nodes[id];
  const title = !node ? `${data.repo}: the parts` : mode === "expert" ? (node.kind === "journey" ? entryName(node.entry ?? id, data).name : codeName(node, data)) : node.title;
  const text = !node ? (mode === "expert" ? "" : data.summary) : panelText(node, mode);
  return (
    <header className="level-head">
      <h1 className={mode === "expert" ? "mono" : ""}>{title}</h1>
      {text && <p className="muted"><Prose text={text} /></p>}
    </header>
  );
}

function OpeningNote({ opening }: { opening: Opening }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="banner">
      <span className="spinner" /> Opening “{opening.title}”: Claude is reading the code and writing the next level · {Math.round((now - opening.started) / 1000)} s
    </div>
  );
}

/** Every folder group and system (D19), kept as an option next to the tree. */
function FullMap() {
  const [map, setMap] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    api.map().then(setMap, (e: unknown) => setError(String(e)));
  }, []);
  if (error) return <div className="center-note">Could not load the map: {error}</div>;
  if (!map) return <div className="center-note">Loading…</div>;
  const node = map.map.nodes.find((n) => n.id === selected);
  return (
    <div className="canvas-view" onClick={() => setSelected(null)}>
      <div className="canvas-wrap">
        <Canvas width={map.map.width} height={map.map.height} fitKey="map" wheelZoom>
          <GraphView graph={map.map} active={new Set()} selected={selected} onSelect={setSelected} />
        </Canvas>
        <Legend items={[{ label: "Folder group", slot: 1 }, { label: "Outside system", slot: -1 }]} />
        <div className="hint">{node ? `${node.label}: ${node.files} files · ${node.functions} functions` : "Every folder group. Scroll to zoom, drag to move."}</div>
      </div>
    </div>
  );
}
