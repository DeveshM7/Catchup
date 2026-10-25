import type { TreeData } from "../shared/types";
import { codeName, compactStep, visibleChildren, type Familiarity, type Selection } from "../shared/view";
import { ArchCanvas } from "./ArchCanvas";
import { entryName, MethodLabel } from "./labels";
import { cssVars, pad2 } from "./theme";

const MAX_START = 2;

type Props = {
  data: TreeData;
  mode: Familiarity;
  scope: { files: Set<string>; systems: Set<string> };
  selected: string | null;
  onSelect: (sel: Selection | null) => void;
  onOpen: (id: string) => void;
  onFlow: (id: string) => void;
  onArch: () => void;
};

/** The first screen (D31): what it is, the top parts, the main journeys in a few steps, where to start. Readable in under a minute. */
export function Home({ data, mode, scope, selected, onSelect, onOpen, onFlow, onArch }: Props) {
  const expert = mode === "expert";
  const start = (data.extras?.startHere ?? []).slice(0, MAX_START);
  return (
    <div className="page home">
      <header className="hero">
        <div className="kicker">Catch me up · {data.sha.slice(0, 7)}</div>
        <h1>{data.repo}</h1>
        {!expert && <p className="lead summary">{data.summary}</p>}
      </header>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>The parts</h2>
            {!expert && <p className="muted">Arrows: what a part uses. ▸ opens a part.</p>}
          </div>
          <button className="ghost" onClick={onArch}>Architecture →</button>
        </div>
        <div className="parts-canvas" onClick={() => onSelect(null)}>
          <ArchCanvas
            id="root"
            data={data}
            mode={mode}
            scope={scope}
            selected={selected}
            onSelect={(box) => onSelect(box && data.nodes[box] ? { kind: "node", id: box } : null)}
            onOpen={onOpen}
          />
        </div>
      </section>

      <div className="journeys">
        {data.journeys.map((id, index) => {
          const journey = data.nodes[id];
          if (!journey) return null;
          const all = visibleChildren(journey, data, mode).shown;
          const shown = all.filter((s) => s.stepKind !== "branch" && s.stepKind !== "error");
          const brief = index > 0 || mode !== "new";
          const entry = entryName(journey.entry ?? id, data);
          return (
            <section key={id} className="card journey-card" style={cssVars(journey.color)}>
              <div className="card-head">
                <div>
                  <h2>{expert ? <MethodLabel label={entry.name} /> : <>How it works: {journey.title}</>}</h2>
                  {!brief && <p className="muted mono">{`starts at ${entry.name}${entry.where ? ` in ${entry.where}` : ""}`}</p>}
                </div>
                <button className="ghost" onClick={() => onFlow(id)}>See the flow →</button>
              </div>
              <ol className="home-steps">
                {shown.map((step, i) => (
                  <li key={step.id} className={`${selected === step.id ? "open" : ""} ${compactStep(step, mode) ? "compact" : ""}`}>
                    <span className="home-num">{pad2(i + 1)}</span>
                    <button className="step-line" onClick={() => onSelect({ kind: "node", id: step.id })}>
                      {expert ? (
                        <span className="mono">{codeName(step, data)}</span>
                      ) : (
                        <>
                          <strong>{step.title}</strong>
                          {!brief && !compactStep(step, mode) && <span className="muted"> {step.short}</span>}
                        </>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
              {all.length > shown.length && (
                <button className="link-text small more" onClick={() => onFlow(id)}>
                  +{all.length - shown.length} path{all.length - shown.length === 1 ? "" : "s"} that only happen sometimes →
                </button>
              )}
            </section>
          );
        })}
      </div>

      {start.length > 0 && (
        <section className="start-here">
          <span className="kicker">Start here</span>
          {start.map((s) => (
            <div key={s.file} className="start-row">
              <button className="start-file mono" onClick={() => onSelect({ kind: "file", path: s.file })}>{s.file}</button>
              {!expert && <span className="muted">{s.why}</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
