import { useEffect, useState } from "react";
import type { FunctionRef, NodeView, SourceView, TreeData, TreeNodeView, TreeView } from "../shared/types";
import { canOpen, codeName, journeyOf, panelText, partsOf, rankFiles, usedIn, type Familiarity, type Selection } from "../shared/view";
import { api } from "./api";
import { entryLabel, entryName, MethodLabel, Prose } from "./labels";
import { systemName } from "./StepsCanvas";
import { TreeList } from "./TreeList";

type Props = {
  data: TreeData;
  mode: Familiarity;
  /** Go deeper from inside the panel (Back returns here). */
  onSelect: (sel: Selection) => void;
  onOpen: (id: string) => void;
  /** Opens the Ask chat about a box (Build 5). */
  onAsk?: (id: string) => void;
};

const KIND = { part: "Part of the code", system: "Outside system", journey: "Journey", step: "Step" } as const;

/** The side panel for one selection. */
export function Panel({ sel, ...props }: Props & { sel: Selection }) {
  if (sel.kind === "node") {
    const node = props.data.nodes[sel.id];
    return node ? <NodePanel node={node} {...props} /> : <div className="panel muted">Not in the tree.</div>;
  }
  if (sel.kind === "file") return <FilePanel path={sel.path} {...props} />;
  if (sel.kind === "fn") return <FunctionPanel id={sel.id} entry={sel.entry} {...props} />;
  return <EntryPanel entry={sel.id} {...props} />;
}

function stepLabel(node: NodeView, data: TreeData): string {
  const parent = node.parent ? data.nodes[node.parent] : undefined;
  const index = parent && Array.isArray(parent.children) ? parent.children.indexOf(node.id) + 1 : 0;
  const kind = node.stepKind === "error" ? " · error path" : node.stepKind === "branch" ? " · only sometimes" : node.stepKind === "check" ? " · check" : "";
  return `Step ${index}${kind}`;
}

function NodePanel({ node, data, mode, onSelect, onOpen, onAsk }: Props & { node: NodeView }) {
  const text = panelText(node, mode);
  const title = mode === "expert" ? codeName(node, data) : node.title;
  const entry = journeyOf(node.id, data)?.entry;
  const functions = node.functions.flatMap((id) => data.refs[id] ?? []);
  const steps = node.kind === "journey" && Array.isArray(node.children) ? node.children.flatMap((id) => data.nodes[id] ?? []) : [];
  const parts = node.kind === "journey" || node.kind === "step" ? partsOf(node, data) : [];
  const uses = node.kind === "part" || node.kind === "system" ? usedIn(node.files, data) : [];
  const opens = canOpen(node);
  return (
    <div className="panel">
      <div className="eyebrow">{node.kind === "step" ? stepLabel(node, data) : node.kind === "system" && node.short.startsWith("Outside tool") ? "Outside tool" : KIND[node.kind]}{node.entry ? ` · ${entryName(node.entry, data).name}` : ""}</div>
      <h2 className={mode === "expert" ? "mono" : ""}>{title}</h2>
      {text && <p><Prose text={text} /></p>}
      {opens && (
        <button className="primary" onClick={() => onOpen(node.id)}>
          {node.children === "unopened" ? "Open ▸ (Claude writes this level, about a minute)" : node.kind === "journey" ? "See every step ▸" : node.kind === "part" && node.children === "leaf" ? "Open: show its files ▸" : "Open ▸"}
        </button>
      )}
      {onAsk && (
        <button className="ghost small ask-this" onClick={() => onAsk(node.id)}>Ask about this</button>
      )}
      {node.systems.length > 0 && (
        <>
          <div className="eyebrow">Talks to</div>
          <div className="chips">
            {node.systems.map((s) => (
              <button key={s} className="chip system link" onClick={() => data.nodes[s] && onSelect({ kind: "node", id: s })}>{systemName(s, data)}</button>
            ))}
          </div>
        </>
      )}
      {parts.length > 0 && (
        <>
          <div className="eyebrow">Runs through</div>
          <div className="chips">
            {parts.map((p) => (
              <button key={p.id} className="chip link" onClick={() => onSelect({ kind: "node", id: p.id })}>{mode === "expert" ? codeName(p, data) : p.title}</button>
            ))}
          </div>
        </>
      )}
      {steps.length > 0 && (
        <>
          <div className="eyebrow">Steps</div>
          <ol className="step-list">
            {steps.map((s) => (
              <li key={s.id} className={s.stepKind ?? "main"}>
                <button className="link-text" onClick={() => onSelect({ kind: "node", id: s.id })}>{mode === "expert" ? codeName(s, data) : s.title}</button>
              </li>
            ))}
          </ol>
        </>
      )}
      {functions.length > 0 && (
        <>
          <div className="eyebrow">Code that does this ({functions.length})</div>
          <FnList fns={functions} onPick={(fn) => onSelect({ kind: "fn", id: fn.id, ...(entry ? { entry } : {}) })} />
        </>
      )}
      {node.kind === "journey" && node.entry && (
        <button className="ghost small" onClick={() => onSelect({ kind: "entry", id: node.entry ?? "" })}>Full call tree →</button>
      )}
      {(node.kind === "part" || node.kind === "system") && <FileGroups node={node} data={data} mode={mode} onSelect={onSelect} />}
      {uses.length > 0 && <UsedIn groups={uses} data={data} mode={mode} onSelect={onSelect} />}
    </div>
  );
}

function FnList({ fns, onPick }: { fns: FunctionRef[]; onPick: (fn: FunctionRef) => void }) {
  return (
    <ul className="fn-list">
      {fns.map((fn) => (
        <li key={fn.id}>
          <button className="fn-link" onClick={() => onPick(fn)}>{fn.name}()</button>
          <span className="where">{fn.file}:{fn.startLine}</span>
        </li>
      ))}
    </ul>
  );
}

/** A part's files grouped by its sub-parts, all listed, so any function is three clicks from the home screen. */
function FileGroups({ node, data, mode, onSelect }: { node: NodeView; data: TreeData; mode: Familiarity; onSelect: (sel: Selection) => void }) {
  const children = Array.isArray(node.children) ? node.children.flatMap((id) => data.nodes[id] ?? []).filter((c) => c.kind === "part") : [];
  const groups = children.length ? children.map((c) => ({ title: mode === "expert" ? codeName(c, data) : c.title, files: c.files })) : [{ title: "", files: node.files }];
  return (
    <>
      <div className="eyebrow">{node.kind === "system" ? "Files that call it" : "Files"} ({node.files.length})</div>
      {groups.map((g) => (
        <div key={g.title} className="file-group">
          {g.title && <div className="file-group-title">{g.title}</div>}
          <FileList files={g.files} data={data} onSelect={onSelect} />
        </div>
      ))}
    </>
  );
}

/** Files ranked by how many flows use them; a click unfolds the file's functions. */
function FileList({ files, data, onSelect }: { files: string[]; data: TreeData; onSelect: (sel: Selection) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="file-list">
      {rankFiles(files, data).map((path) => {
        const view = data.files[path];
        const fns = (view?.functions ?? []).flatMap((id) => data.refs[id] ?? []);
        return (
          <li key={path} className={open === path ? "open" : ""}>
            <button className="file-row" onClick={() => setOpen(open === path ? null : path)}>
              <span className="twisty">{fns.length ? (open === path ? "▾" : "▸") : ""}</span>
              <span className="mono">{path}</span>
              {view && view.flows > 0 && <span className="where">{view.flows} flows</span>}
            </button>
            {open === path && (
              <div className="file-fns">
                <FnList fns={fns} onPick={(fn) => onSelect({ kind: "fn", id: fn.id })} />
                <button className="link-text small" onClick={() => onSelect({ kind: "file", path })}>About this file →</button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function UsedIn({ groups, data, mode, onSelect }: { groups: ReturnType<typeof usedIn>; data: TreeData; mode: Familiarity; onSelect: (sel: Selection) => void }) {
  return (
    <>
      <div className="eyebrow">Used in</div>
      {groups.map(({ journey, steps }) => (
        <div key={journey.id} className="used-in">
          <button className="link-text strong" onClick={() => onSelect({ kind: "node", id: journey.id })}>{mode === "expert" ? entryName(journey.entry ?? journey.id, data).name : journey.title}</button>
          <ul className="fn-list">
            {steps.map((s) => (
              <li key={s.id}><button className="link-text" onClick={() => onSelect({ kind: "node", id: s.id })}>{mode === "expert" ? codeName(s, data) : s.title}</button></li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function FilePanel({ path, data, mode, onSelect }: Props & { path: string }) {
  const view = data.files[path];
  if (!view) return <div className="panel muted">Not a source file.</div>;
  const fns = view.functions.flatMap((id) => data.refs[id] ?? []);
  const uses = usedIn([path], data);
  return (
    <div className="panel">
      <div className="eyebrow">File{view.side ? ` · ${view.side}` : ""}</div>
      <h2 className="mono">{path}</h2>
      <div className="muted">{view.loc} lines · {fns.length} functions · used by {view.flows} flows</div>
      {view.systems.length > 0 && (
        <>
          <div className="eyebrow">Talks to</div>
          <div className="chips">
            {view.systems.map((s) => (
              <button key={s} className="chip system link" onClick={() => data.nodes[`system:${s}`] && onSelect({ kind: "node", id: `system:${s}` })}>{s}</button>
            ))}
          </div>
        </>
      )}
      <div className="eyebrow">Functions</div>
      <FnList fns={fns} onPick={(fn) => onSelect({ kind: "fn", id: fn.id })} />
      {uses.length > 0 && <UsedIn groups={uses} data={data} mode={mode} onSelect={onSelect} />}
    </div>
  );
}

function findNode(node: TreeNodeView, id: string): Extract<TreeNodeView, { kind: "function" }> | undefined {
  if (node.kind !== "function") return undefined;
  if (node.fn.id === id && !node.flags.includes("shown above")) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

/** The bottom level: what a function calls (its subtree in a journey's call tree) and its source. */
function FunctionPanel({ id, entry, data, onSelect }: Props & { id: string; entry: string | undefined }) {
  const fn = data.refs[id];
  const [tree, setTree] = useState<TreeView | null | "none">(null);
  const [source, setSource] = useState<SourceView | null>(null);
  const [showNoise, setShowNoise] = useState(false);
  useEffect(() => {
    let live = true;
    setTree(null);
    setSource(null);
    api.fnCalls(id, entry).then((t) => live && setTree(t), () => live && setTree("none"));
    api.source(id).then((s) => live && setSource(s), () => live && setSource(null));
    return () => {
      live = false;
    };
  }, [id, entry]);
  if (!fn) return <div className="panel muted">Unknown function.</div>;
  const node = tree && tree !== "none" ? findNode(tree.root, id) : undefined;
  const pick = (f: FunctionRef): void => onSelect({ kind: "fn", id: f.id, ...(entry ? { entry } : {}) });
  return (
    <div className="panel">
      <div className="eyebrow">Function · {fn.component}</div>
      <h2 className="mono">{fn.name}()</h2>
      <button className="where link-text" onClick={() => onSelect({ kind: "file", path: fn.file })}>{fn.file}:{fn.startLine}–{fn.endLine}</button>
      <div className="row-between">
        <div className="eyebrow">What it calls</div>
        {node && node.children.length > 0 && (
          <label className="toggle"><input type="checkbox" checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} /> minor helpers</label>
        )}
      </div>
      {tree === null ? (
        <p className="muted">Loading…</p>
      ) : node && node.children.length ? (
        <TreeList nodes={node.children} showNoise={showNoise} onOpen={pick} />
      ) : (
        <p className="muted">{tree === "none" ? "No traced flow reaches this function." : "No further calls."}</p>
      )}
      <div className="eyebrow">Code</div>
      <pre className="code">
        {source
          ? source.text.split("\n").map((line, i) => (
              <div key={i}>
                <span className="ln">{source.startLine + i}</span>
                {line}
              </div>
            ))
          : "Loading…"}
      </pre>
    </div>
  );
}

/** A flow outside the main journeys: its one line and its call tree. */
function EntryPanel({ entry, data, mode, onSelect }: Props & { entry: string }) {
  const [tree, setTree] = useState<TreeView | null>(null);
  const [showNoise, setShowNoise] = useState(false);
  const other = data.otherFlows.find((f) => f.entry === entry);
  useEffect(() => {
    let live = true;
    setTree(null);
    api.entryCalls(entry).then((t) => live && setTree(t), () => live && setTree(null));
    return () => {
      live = false;
    };
  }, [entry]);
  const pick = (f: FunctionRef): void => onSelect({ kind: "fn", id: f.id, entry });
  return (
    <div className="panel">
      <div className="eyebrow">Flow{other && other.members > 1 ? ` · ${other.family} (${other.members} alike)` : ""}</div>
      <h2><MethodLabel label={other?.label ?? entryLabel(entry)} /></h2>
      {other && mode !== "expert" && <p><Prose text={other.line} /></p>}
      {tree ? (
        <>
          {tree.systems.length > 0 && <div className="chips">{tree.systems.map((s) => <span key={s} className="chip system">{s}</span>)}</div>}
          <div className="row-between">
            <div className="eyebrow">Calls{tree.partial ? " · partial" : ""}</div>
            <label className="toggle"><input type="checkbox" checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} /> minor helpers</label>
          </div>
          {tree.root.kind === "function" && (
            <>
              <button className="fn-link" onClick={() => tree.root.kind === "function" && pick(tree.root.fn)}>{tree.root.fn.name}()</button>
              <TreeList nodes={tree.root.children} showNoise={showNoise} onOpen={pick} />
            </>
          )}
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </div>
  );
}
