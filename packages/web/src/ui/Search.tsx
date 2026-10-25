import { useState } from "react";
import type { TreeData } from "../shared/types";
import type { Selection } from "../shared/view";

const MAX = 8;

/** Find a function or file by name: the shortcut to any code. */
export function Search({ data, onPick }: { data: TreeData; onPick: (sel: Selection) => void }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const fns = needle ? Object.values(data.refs).filter((f) => f.name.toLowerCase().includes(needle)).slice(0, MAX) : [];
  const files = needle ? Object.keys(data.files).filter((p) => p.toLowerCase().includes(needle)).slice(0, MAX - fns.length) : [];
  const pick = (sel: Selection): void => {
    setQ("");
    onPick(sel);
  };
  return (
    <div className="search">
      <input value={q} placeholder="Find a function or file" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
      {needle && (
        <ul className="search-results">
          {fns.map((f) => (
            <li key={f.id}><button onClick={() => pick({ kind: "fn", id: f.id })}><span className="mono">{f.name}()</span><span className="where">{f.file}</span></button></li>
          ))}
          {files.map((p) => (
            <li key={p}><button onClick={() => pick({ kind: "file", path: p })}><span className="mono">{p}</span></button></li>
          ))}
          {fns.length + files.length === 0 && <li className="muted">No match</li>}
        </ul>
      )}
    </div>
  );
}
