import type { AskEvent, AskRequest, MapData, MapGraph, PreviewView, SourceView, TimelapseView, TreeData, TreeView } from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T | { error?: string };
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${path}: ${res.status}`);
  return body as T;
}

/** One request per key; a failed one is forgotten so it can be retried. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const next = load();
  cache.set(key, next);
  next.catch(() => cache.delete(key));
  return next;
}

const canvases = new Map<string, Promise<MapGraph>>();
const calls = new Map<string, Promise<TreeView>>();
const sources = new Map<string, Promise<SourceView>>();
const q = encodeURIComponent;

/** On the Preview tab, panels read the working tree's code (call trees, source), not HEAD's; it changes on every save, so it isn't cached. */
let workingTree = false;
export function setWorkingTree(on: boolean): void {
  workingTree = on;
}
const fromCode = <T>(cache: Map<string, Promise<T>>, key: string, path: string): Promise<T> =>
  workingTree ? request(`${path}&preview=1`) : cached(cache, key, () => request(path));

export const api = {
  understanding: (): Promise<TreeData> => request("/api/understanding"),
  canvas: (id: string): Promise<MapGraph> => cached(canvases, id, () => request(`/api/canvas?id=${q(id)}`)),
  /** Runs the Open pass for a node (may take a minute); later canvases are drawn from the new tree. */
  async open(id: string): Promise<TreeData> {
    const data = await request<TreeData>(`/api/open?id=${q(id)}`, { method: "POST" });
    canvases.clear();
    return data;
  },
  entryCalls: (entry: string): Promise<TreeView> => fromCode(calls, `entry:${entry}`, `/api/calls?entry=${q(entry)}`),
  fnCalls: (fn: string, entry?: string): Promise<TreeView> => fromCode(calls, `fn:${fn}:${entry ?? ""}`, `/api/calls?fn=${q(fn)}${entry ? `&entry=${q(entry)}` : ""}`),
  source: (fn: string): Promise<SourceView> => fromCode(sources, fn, `/api/source?fn=${q(fn)}`),
  map: (): Promise<MapData> => request("/api/map"),
  /** Stored timelapses (Build 9), oldest file name first. */
  timelapses: (): Promise<{ from: string; to: string }[]> => request("/api/timelapses"),
  timelapse: (from: string, to: string): Promise<TimelapseView> => request(`/api/timelapse?from=${q(from)}&to=${q(to)}`),
  /** The live preview's latest state (Build 7); not cached, it changes with every save. */
  preview: (): Promise<PreviewView> => request("/api/preview"),
  /** A canvas of the working tree's tree; keyed by when the preview was computed. */
  previewCanvas: (id: string, version: string): Promise<MapGraph> => cached(canvases, `preview:${version}:${id}`, () => request(`/api/preview/canvas?id=${q(id)}`)),
  /** Asks a question; `onEvent` gets each tool step as it happens, then the answer or an error (Build 5). */
  async ask(body: AskRequest, onEvent: (event: AskEvent) => void): Promise<void> {
    const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) throw new Error(`ask failed: ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as AskEvent);
      if (done) break;
    }
  },
};
