import type { MapData, MapGraph, SourceView, TreeData, TreeView } from "../shared/types";

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

export const api = {
  understanding: (): Promise<TreeData> => request("/api/understanding"),
  canvas: (id: string): Promise<MapGraph> => cached(canvases, id, () => request(`/api/canvas?id=${q(id)}`)),
  /** Runs the Open pass for a node (may take a minute); later canvases are drawn from the new tree. */
  async open(id: string): Promise<TreeData> {
    const data = await request<TreeData>(`/api/open?id=${q(id)}`, { method: "POST" });
    canvases.clear();
    return data;
  },
  entryCalls: (entry: string): Promise<TreeView> => cached(calls, `entry:${entry}`, () => request(`/api/calls?entry=${q(entry)}`)),
  fnCalls: (fn: string, entry?: string): Promise<TreeView> =>
    cached(calls, `fn:${fn}:${entry ?? ""}`, () => request(`/api/calls?fn=${q(fn)}${entry ? `&entry=${q(entry)}` : ""}`)),
  source: (fn: string): Promise<SourceView> => cached(sources, fn, () => request(`/api/source?fn=${q(fn)}`)),
  map: (): Promise<MapData> => request("/api/map"),
};
