import type { TreeData } from "../shared/types";
import { splitLabel } from "./theme";

/** "POST /api/chat" with the method as a colored tag. */
export function MethodLabel({ label }: { label: string }) {
  const [method, path] = splitLabel(label);
  return (
    <>
      {method && <span className={`method ${method.toLowerCase()}`}>{method}</span>}
      <span className="path">{path}</span>
    </>
  );
}

/** Claude's text with `code names` set as code. */
export function Prose({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

/** An entry point id without its kind prefix ("http:POST /api/chat" → "POST /api/chat"). */
export const entryLabel = (entry: string): string => entry.replace(/^\w+:/, "");

/** How to name an entry point in the UI: a function entry (UI events) by its function, a route by its label. */
export function entryName(entry: string, data: TreeData): { name: string; where: string } {
  const fn = data.refs[entry] ?? data.refs[entryLabel(entry)];
  return fn ? { name: `${fn.name.split(".").pop() ?? fn.name}()`, where: fn.file } : { name: entryLabel(entry), where: "" };
}
