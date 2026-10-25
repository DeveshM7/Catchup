/** Client → server links (Build 1, D39): a URL written in client code that matches one of our routes. */

import type { CallFact, EntryPointFact, Side } from "./facts.js";

/** Stands for a `${…}` part of a template string. */
export const PLACEHOLDER = "\u0000";

export type Route = { method: string; url: string; entry: string; handler: string };

const ORIGIN = new RegExp(`^(?:${PLACEHOLDER}|https?://[^/${PLACEHOLDER}]*)*`);

/** The path part of a written URL: drops a base (`${BASE}`, `https://host`), the query and the hash. */
export function urlPath(text: string): string | undefined {
  const rest = text.slice(ORIGIN.exec(text)![0].length);
  if (!rest.startsWith("/") || rest.startsWith("//")) return undefined;
  const path = rest.split(/[?#]/, 1)[0]!;
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|\\]/g, "\\$&");
}

/** `/api/chat/[id]/stream` → a regex where `[id]` matches one segment (or a `${…}`) and `[...rest]` the rest. */
export function routePattern(url: string): RegExp {
  const parts = url.split("/").map((segment) => {
    if (/^\[\[?\.\.\.[^\]]+\]\]?$/.test(segment)) return ".+";
    if (/^\[[^\]]+\]$/.test(segment)) return `[^/]+`;
    return escape(segment);
  });
  return new RegExp(`^${parts.join("/")}$`);
}

/** Client code calling a server action (`"use server"` export) makes a request: mark the call `remote`. */
export function markActionCalls(calls: CallFact[], entryPoints: EntryPointFact[], sides: Map<string, Side>): void {
  const actionOf = new Map(entryPoints.filter((e) => e.kind === "action").map((e) => [e.handler, e.id]));
  for (const call of calls) {
    const action = call.kind === "direct" && call.to !== null ? actionOf.get(call.to) : undefined;
    if (action !== undefined && !call.passed && sides.get(call.from.slice(0, call.from.indexOf("#"))) !== "server") call.remote = action;
  }
}

/**
 * Routes a written URL may call. With a known method only that method; otherwise every method at the
 * matching path. Exact paths win over ones with dynamic segments.
 */
export function matchRoutes(text: string, method: string | undefined, routes: Route[]): Route[] {
  const path = urlPath(text);
  if (path === undefined) return [];
  const hits = routes.filter((r) => (method === undefined || r.method === method || r.method === "ANY") && routePattern(r.url).test(path));
  const exact = hits.filter((r) => r.url === path);
  return exact.length > 0 ? exact : hits;
}
