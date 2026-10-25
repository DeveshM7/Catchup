import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AskReply, AskStep, TreeData } from "../shared/types";
import { codeName, type Familiarity, type Selection } from "../shared/view";
import { api } from "./api";

/** One question and what came back. */
export type Turn = { id: number; question: string; node?: string; steps: AskStep[]; reply?: AskReply; error?: string };

type Props = {
  data: TreeData;
  mode: Familiarity;
  turns: Turn[];
  setTurns: (update: (turns: Turn[]) => Turn[]) => void;
  /** The box the next question is about, if any. */
  about: string | null;
  onAbout: (id: string | null) => void;
  /** The answer whose cites are lit on the canvases. */
  lit: number | null;
  onLight: (turn: Turn) => void;
  onSelect: (sel: Selection) => void;
  onClose: () => void;
};

const HISTORY = 3;

/** `code` and **bold** inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : part.startsWith("**") && part.endsWith("**") && part.length > 3 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}

/** Paragraphs and numbered or bulleted lists, enough for an answer. */
function AnswerText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const list = lines.length > 0 && lines.every((l) => /^\s*(\d+\.|[-*])\s/.test(l));
        if (list) {
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*(\d+\.|[-*])\s/, ""))}</li>);
          return /^\s*\d/.test(lines[0] ?? "") ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        if (lines.length === 1 && /^\s*\d+\.\s/.test(lines[0] ?? "")) return <ol key={i} start={Number(/\d+/.exec(lines[0]!)![0])}><li>{inline(lines[0]!.replace(/^\s*\d+\.\s/, ""))}</li></ol>;
        return <p key={i}>{inline(block)}</p>;
      })}
    </>
  );
}

function Cites({ reply, data, mode, onSelect }: { reply: AskReply; data: TreeData; mode: Familiarity; onSelect: (sel: Selection) => void }) {
  const name = (id: string): string => {
    const node = data.nodes[id];
    return node ? (mode === "expert" ? codeName(node, data) : node.title) : id;
  };
  return (
    <div className="chips cites">
      {reply.nodes.map((id) => (
        <button key={id} className="chip link" onClick={() => onSelect({ kind: "node", id })}>{name(id)}</button>
      ))}
      {reply.functions.map((id) => (
        <button key={id} className="chip link mono" onClick={() => onSelect({ kind: "fn", id })}>{data.refs[id]?.name ?? id}()</button>
      ))}
      {reply.files.map((path) => (
        <button key={path} className="chip link mono" onClick={() => onSelect({ kind: "file", path })} title={path}>{path.split("/").pop()}</button>
      ))}
    </div>
  );
}

function Steps({ steps, done }: { steps: AskStep[]; done: boolean }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const shown = done && !open ? [] : steps;
  return (
    <div className="ask-steps">
      {done && (
        <button className="link-text small" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Read {steps.length} thing{steps.length === 1 ? "" : "s"} in the code
        </button>
      )}
      {shown.map((s, i) => (
        <div key={i} className={`ask-step ${s.denied ? "denied" : ""}`} title={s.denied}>
          <span className="tool">{s.name}</span> {s.target || "…"}
        </div>
      ))}
    </div>
  );
}

/** The Ask chat (Build 5): a read-only agent answers about the code; its answers cite boxes, functions and files. */
export function AskPanel({ data, mode, turns, setTurns, about, onAbout, lit, onLight, onSelect, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => !t.reply && !t.error);
  useEffect(() => {
    // Recent browsers return a Promise from scrollIntoView; an effect must return nothing.
    void end.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const send = async (): Promise<void> => {
    const text = question.trim();
    if (!text || busy) return;
    const id = Date.now();
    const history = turns.flatMap((t) => (t.reply ? [{ question: t.question, answer: t.reply.answer }] : [])).slice(-HISTORY);
    setQuestion("");
    setTurns((all) => [...all, { id, question: text, ...(about ? { node: about } : {}), steps: [] }]);
    const update = (change: Partial<Turn>): void => setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...change } : t)));
    try {
      await api.ask({ question: text, ...(about ? { node: about } : {}), history }, (event) => {
        if (event.type === "step") setTurns((all) => all.map((t) => (t.id === id ? { ...t, steps: [...t.steps, event.step] } : t)));
        else if (event.type === "error") update({ error: event.error });
        else {
          update({ reply: event.reply });
          onLight({ id, question: text, steps: event.reply.steps, reply: event.reply });
        }
      });
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  const aboutNode = about ? data.nodes[about] : undefined;
  return (
    <aside className="ask">
      <div className="panel-bar">
        <strong>Ask about the code</strong>
        <button className="close" onClick={onClose} title="Close">×</button>
      </div>
      <div className="ask-turns">
        {turns.length === 0 && (
          <p className="muted ask-empty">
            Ask how something works, where to change it, or why. A read-only agent reads the code and answers; the boxes it cites light up.
          </p>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`ask-turn ${lit === t.id ? "lit" : ""}`}>
            <div className="ask-q">
              {t.node && data.nodes[t.node] && <span className="chip">{data.nodes[t.node]!.title}</span>} {t.question}
            </div>
            <Steps steps={t.steps} done={Boolean(t.reply || t.error)} />
            {t.error && <div className="ask-error">{t.error}</div>}
            {!t.reply && !t.error && (
              <div className="muted small"><span className="spinner" /> Reading the code…</div>
            )}
            {t.reply && (
              <div className="ask-a" onClick={() => onLight(t)} title="Light up what this answer cites">
                <AnswerText text={t.reply.answer} />
                <Cites reply={t.reply} data={data} mode={mode} onSelect={onSelect} />
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="ask-input">
        {aboutNode && (
          <div className="ask-about">
            About <span className="chip">{mode === "expert" ? codeName(aboutNode, data) : aboutNode.title}</span>
            <button className="close" onClick={() => onAbout(null)} title="Ask about the whole app">×</button>
          </div>
        )}
        <textarea
          value={question}
          placeholder={aboutNode ? `Ask about “${aboutNode.title}”…` : "How does sending a message work?"}
          rows={3}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" onClick={() => void send()} disabled={busy || !question.trim()}>
          {busy ? "Answering…" : "Ask"}
        </button>
      </div>
    </aside>
  );
}
