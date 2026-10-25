import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ChangeSetView, JourneyChangeView, PreviewView, TreeData } from "../shared/types";
import { pathTo, type Familiarity, type Selection, type Scope } from "../shared/view";
import { api } from "./api";
import { ArchCanvas } from "./ArchCanvas";

const FAST = 1500;
const SLOW = 5000;
const SHOWN = 6;

/** Polls the live preview: often while it's on screen, rarely otherwise (for the tab's count). */
export function usePreview(active: boolean): PreviewView | null {
  const [view, setView] = useState<PreviewView | null>(null);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        const next = await api.preview();
        if (live) setView((previous) => {
          if (previous?.updatedAt === next.updatedAt && previous.runs === next.runs) {
            return { ...next, tree: previous.tree, changes: previous.changes };
          }
          return next;
        });
      } catch {
        // the server restarts or is busy; try again on the next tick
      }
      if (live) timer = window.setTimeout(() => void tick(), active ? FAST : SLOW);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [active]);
  return view;
}

/** How many things a change set reports (the tab's badge). */
export function changeCount(c: ChangeSetView | null): number {
  if (!c) return 0;
  return c.files.added.length + c.files.removed.length + c.files.renamed.length + c.files.changed.length;
}

const fnName = (id: string): string => `${id.slice(id.indexOf("#") + 1)}()`;

function List({ items, render }: { items: string[]; render?: (item: string) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      {shown.map((item) => (
        <li key={item}>{render ? render(item) : <code>{item}</code>}</li>
      ))}
      {items.length > SHOWN && (
        <li>
          <button className="link-text small" onClick={() => setAll(!all)}>{all ? "show fewer" : `+${items.length - SHOWN} more`}</button>
        </li>
      )}
    </>
  );
}

/** What a change does to one journey, in the words a reviewer cares about (behavior first). */
function JourneyCard({ j, onAsk }: { j: JourneyChangeView; onAsk: (text: string) => void }) {
  const facts: { tone: string; text: ReactNode }[] = [
    ...j.systemsAdded.map((s) => ({ tone: "add", text: <>now uses <strong>{s}</strong></> })),
    ...j.systemsRemoved.map((s) => ({ tone: "remove", text: <>no longer uses <strong>{s}</strong></> })),
    ...j.checksRemoved.map((s) => ({ tone: "warn", text: <>check removed: <strong>{s}</strong></> })),
    ...j.stepsAdded.map((s) => ({ tone: "add", text: <>new step: {s}</> })),
    ...j.stepsRemoved.map((s) => ({ tone: "remove", text: <>step gone: {s}</> })),
  ];
  return (
    <section className="card change-card">
      <div className="card-head">
        <h3>{j.title}</h3>
        <button className="ghost small" onClick={() => onAsk(journeyQuestion(j))}>Ask about this</button>
      </div>
      <ul className="facts">
        {facts.map((f, i) => (
          <li key={i} className={f.tone}>{f.text}</li>
        ))}
      </ul>
      {j.functionsRemoved.length > 0 && (
        <div className="fn-delta">
          <span className="muted small">No longer runs</span>
          <ul className="inline-list"><List items={j.functionsRemoved} render={(f) => <code className="removed">{fnName(f)}</code>} /></ul>
        </div>
      )}
      {j.functionsAdded.length > 0 && (
        <div className="fn-delta">
          <span className="muted small">Now runs</span>
          <ul className="inline-list"><List items={j.functionsAdded} render={(f) => <code className="added">{fnName(f)}</code>} /></ul>
        </div>
      )}
    </section>
  );
}

/** The question an "Ask about this" on a journey card starts with. */
function journeyQuestion(j: JourneyChangeView): string {
  const check = j.checksRemoved[0];
  if (check) return `In "${j.title}", the check "${check}" looks removed. What exactly was dropped, and what can a user do now that they couldn't before?`;
  const system = j.systemsAdded[0];
  if (system) return `"${j.title}" now uses ${system}. What does it do with it, and what happens if ${system} is down?`;
  return `What do these changes do to "${j.title}"?`;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

type Props = {
  view: PreviewView | null;
  mode: Familiarity;
  selected: string | null;
  onSelect: (sel: Selection | null) => void;
  /** Opens Ask about the uncommitted changes, optionally with a question in the box. */
  onAsk: (text?: string) => void;
  level: string;
  onOpen: (id: string) => void;
  scope: Scope;
};

/** Uncommitted changes as they will land (Build 7): behavior first, then the parts touched, then every file and box. */
export function PreviewPage({ view, mode, selected, onSelect, onAsk, level, onOpen, scope }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!view) return <div className="center-note">Loading…</div>;
  if (view.status === "off") return <div className="center-note">The live preview needs an understanding tree for HEAD; run: catchup understand &lt;path&gt;</div>;
  const c = view.changes;
  const tree = view.tree;
  const empty = !c || changeCount(c) === 0;
  return (
    <div className="page preview">
      <header className="hero">
        <div className="kicker">
          Uncommitted changes · against HEAD {view.head.slice(0, 7)} · {view.status === "analyzing" ? <><span className="spinner" /> analyzing…</> : <>updated {ago(view.updatedAt, now)} (took {(view.durationMs / 1000).toFixed(1)} s)</>}
        </div>
        <h1>What your changes do</h1>
        {!empty && (
          <div className="hero-actions">
            <button className="primary" onClick={() => onAsk()}>Ask about these changes</button>
          </div>
        )}
        {view.error && <p className="ask-error">Could not analyze the working tree: {view.error}</p>}
        {empty && !view.error && <p className="lead">No changes to the code since HEAD. Save a file and this page updates within a few seconds.</p>}
      </header>
      {c && !empty && tree && <Changes c={c} tree={tree} mode={mode} version={view.updatedAt ?? ""} selected={selected} onSelect={onSelect} onAsk={onAsk} level={level} onOpen={onOpen} scope={scope} />}
    </div>
  );
}

type ChangesProps = Omit<Props, "view"> & { c: ChangeSetView; tree: TreeData; version: string };

function Changes({ c, tree, mode, version, selected, onSelect, onAsk, level: requestedLevel, onOpen, scope: selectedScope }: ChangesProps) {
  // The canvas opens like Architecture's (parts → sub-parts → files), inside the preview's own tree.
  const trail = pathTo(requestedLevel, tree).filter((n) => n.kind === "part").map((n) => n.id);
  const level = trail.at(-1) ?? "root";
  const loadCanvas = useCallback((id: string) => api.previewCanvas(id, version), [version]);
  const pick = (box: string | null): void => {
    if (!box) return onSelect(null);
    if (box.startsWith("file:")) return onSelect({ kind: "file", path: box.slice("file:".length) });
    onSelect(tree.nodes[box] ? { kind: "node", id: box } : null);
  };
  const openBox = (id: string): void => {
    const node = tree.nodes[id];
    if (node?.kind === "part") onOpen(id);
  };
  const touchedFiles = new Set([...c.files.added, ...c.files.changed, ...c.files.renamed.map((r) => r.to)]);
  const added = new Set(c.nodes.added.map((n) => n.id));
  const changed = new Set(c.nodes.changed.map((n) => n.id));
  const statusOf = (box: string): string | undefined => {
    if (added.has(box)) return "added";
    if (changed.has(box)) return "changed";
    const files = box.startsWith("file:") ? [box.slice("file:".length)] : (tree.nodes[box]?.files ?? []);
    return files.some((f) => touchedFiles.has(f)) ? "touched" : undefined;
  };
  const scope = selectedScope.files.size || selectedScope.systems.size || selectedScope.nodes?.size
    ? selectedScope
    : { files: touchedFiles, systems: new Set(c.systems.added.map((s) => `system:${s}`)) };
  return (
    <>
      {c.journeys.length > 0 && (
        <div className="change-grid">
          {c.journeys.map((j) => (
            <JourneyCard key={j.id} j={j} onAsk={onAsk} />
          ))}
        </div>
      )}
      {(c.entryPoints.added.length + c.entryPoints.removed.length + c.systems.added.length + c.systems.removed.length > 0) && (
        <section className="card change-card">
          <h3>New and removed</h3>
          <ul className="facts">
            {c.entryPoints.added.map((e) => <li key={`+${e}`} className="add">new entry point <code>{e}</code></li>)}
            {c.entryPoints.removed.map((e) => <li key={`-${e}`} className="remove">entry point removed <code>{e}</code></li>)}
            {c.systems.added.map((s) => <li key={`+${s}`} className="add">now talks to <strong>{s}</strong></li>)}
            {c.systems.removed.map((s) => <li key={`-${s}`} className="remove">no longer talks to <strong>{s}</strong></li>)}
          </ul>
        </section>
      )}
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Where it lands</h2>
            <p className="muted">Parts holding changed files are marked; new boxes say so. Click a box for details, ▸ to go inside.</p>
          </div>
        </div>
        <div className="crumbs preview-crumbs">
          {["root", ...trail].map((id, i) => (
            <span key={id} className="crumb-wrap">
              {i > 0 && <span className="sep">/</span>}
              <button className={`crumb ${i === trail.length ? "last" : ""}`} onClick={() => onOpen(id)}>{id === "root" ? "All parts" : tree.nodes[id]!.title}</button>
            </span>
          ))}
        </div>
        <div className="parts-canvas" onClick={() => onSelect(null)}>
          <ArchCanvas
            id={level}
            data={tree}
            mode={mode}
            scope={scope}
            selected={selected}
            onSelect={pick}
            onOpen={openBox}
            load={loadCanvas}
            statusOf={statusOf}
          />
        </div>
      </section>
      <div className="change-grid">
        <section className="card change-card">
          <h3>Files</h3>
          <ul className="files-delta">
            <List items={c.files.added} render={(f) => <button className="link-text add" onClick={() => onSelect({ kind: "file", path: f })}>+ {f}</button>} />
            <List items={c.files.changed} render={(f) => <button className="link-text changed" onClick={() => onSelect({ kind: "file", path: f })}>~ {f}</button>} />
            <List items={c.files.renamed.map((r) => `${r.from} → ${r.to}`)} render={(f) => <span className="changed">→ {f}</span>} />
            <List items={c.files.removed} render={(f) => <span className="remove">− {f}</span>} />
          </ul>
        </section>
        <section className="card change-card">
          <h3>Boxes</h3>
          <ul className="files-delta">
            {c.nodes.added.map((n) => <li key={n.id} className="add">+ {n.title} <span className="muted small">{n.kind}</span></li>)}
            {c.nodes.changed.map((n) => <li key={n.id} className="changed">~ {n.title} <span className="muted small">{n.what.join(", ")}</span></li>)}
            {c.nodes.removed.map((n) => <li key={n.id} className="remove">− {n.title} <span className="muted small">{n.kind}</span></li>)}
          </ul>
        </section>
      </div>
    </>
  );
}
