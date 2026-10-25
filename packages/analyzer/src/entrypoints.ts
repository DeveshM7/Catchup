import type { CallFact, EntryPointFact, FunctionFact } from "./facts.js";
import { compareStrings } from "./sort.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const APP_ROUTE = /(^|\/)app\/(.*\/)?route\.(ts|tsx|js|jsx|mts|mjs)$/;
const PAGES_API = /(^|\/)pages\/(api\/.*)\.(ts|tsx|js|jsx|mts|mjs)$/;

/** Next.js app-router folder path → URL: route groups `(x)` and slots `@x` vanish, `[id]` stays. */
export function appRouteUrl(file: string): string | undefined {
  const match = APP_ROUTE.exec(file);
  if (!match) return undefined;
  const segments = (match[2] ?? "").split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s.startsWith("_"))) return undefined; // private folders are not routable
  const visible = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  return `/${visible.join("/")}`;
}

export function pagesApiUrl(file: string): string | undefined {
  const match = PAGES_API.exec(file);
  if (!match?.[2]) return undefined;
  return `/${match[2]}`.replace(/\/index$/, "") || "/";
}

export type EntryPointInputs = {
  files: string[];
  functions: FunctionFact[];
  /** Name of the local function a file's `export default <identifier>` refers to, if any. */
  defaultExportName: (file: string) => string | undefined;
  /** Function ids that some other function calls directly. */
  calledFunctions: Set<string>;
  /** Entry points found by other detectors (pages, actions, CLI, library, Express-style routes). */
  extra?: EntryPointFact[];
};

/**
 * Entry points by convention: Next.js API routes here, plus `extra` from `findEntrySources`. If nothing
 * matches, falls back to top-level functions that nothing in the repo calls.
 */
export function detectEntryPoints(inputs: EntryPointInputs): EntryPointFact[] {
  const byFile = new Map<string, FunctionFact[]>();
  for (const fn of inputs.functions) byFile.set(fn.file, [...(byFile.get(fn.file) ?? []), fn]);
  const found: EntryPointFact[] = [];

  for (const file of inputs.files) {
    const fns = byFile.get(file) ?? [];
    const appUrl = appRouteUrl(file);
    if (appUrl !== undefined) {
      for (const method of HTTP_METHODS) {
        const handler = fns.find((fn) => fn.name === method);
        if (handler) found.push(httpEntry(method, appUrl, handler));
      }
      continue;
    }
    const pagesUrl = pagesApiUrl(file);
    if (pagesUrl !== undefined) {
      const name = inputs.defaultExportName(file) ?? "default";
      const handler = fns.find((fn) => fn.name === name);
      if (handler) found.push(httpEntry("ANY", pagesUrl, handler));
    }
  }
  const ids = new Set(found.map((e) => e.id));
  for (const e of inputs.extra ?? []) if (!ids.has(e.id)) found.push(e);
  if (found.length > 0) return found.sort((a, b) => compareStrings(a.id, b.id));

  return inputs.functions
    .filter((fn) => !fn.name.includes(".") && !inputs.calledFunctions.has(fn.id))
    .map((fn): EntryPointFact => ({ id: `main:${fn.id}`, kind: "main", label: fn.id, handler: fn.id, file: fn.file }))
    .sort((a, b) => compareStrings(a.id, b.id));
}

/**
 * UI events whose handler reaches the server (a request to our routes) or an outside system: the
 * user's actions that do something beyond the page (Build 1).
 */
export function uiEntryPoints(calls: CallFact[], isSystemPackage: (pkg: string) => boolean): EntryPointFact[] {
  const byFrom = new Map<string, CallFact[]>();
  for (const call of calls) byFrom.set(call.from, [...(byFrom.get(call.from) ?? []), call]);
  const reachesOut = (start: string): boolean => {
    const seen = new Set([start]);
    const queue = [start];
    for (let fn = queue.pop(); fn !== undefined; fn = queue.pop()) {
      for (const call of byFrom.get(fn) ?? []) {
        if (call.remote || (call.kind === "external" && call.target !== undefined && isSystemPackage(call.target))) return true;
        if (call.kind === "direct" && call.to !== null && !call.render && !seen.has(call.to)) {
          seen.add(call.to);
          queue.push(call.to);
        }
      }
    }
    return false;
  };
  const found = new Map<string, EntryPointFact>();
  for (const call of calls) {
    if (!call.event || call.to === null || found.has(call.to) || !reachesOut(call.to)) continue;
    const component = call.from.slice(call.from.indexOf("#") + 1).split(".")[0];
    const label = `${component} ${call.event}`;
    found.set(call.to, { id: `ui:${call.to}`, kind: "ui", label, handler: call.to, file: call.to.slice(0, call.to.indexOf("#")) });
  }
  return distinctLabels([...found.values()]);
}

/** Two handlers for one component's event (two buttons' onClick): the handler's name tells them apart. */
function distinctLabels(entries: EntryPointFact[]): EntryPointFact[] {
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.label, (count.get(e.label) ?? 0) + 1);
  const named = entries.map((e) => (count.get(e.label)! > 1 ? { ...e, label: `${e.label} (${e.handler.slice(e.handler.indexOf("#") + 1)})` } : e));
  const seen = new Map<string, number>();
  return named.map((e) => {
    const n = (seen.get(e.label) ?? 0) + 1;
    seen.set(e.label, n);
    return n > 1 ? { ...e, label: `${e.label} #${n}` } : e;
  });
}

function httpEntry(method: string, url: string, handler: FunctionFact): EntryPointFact {
  const label = `${method} ${url}`;
  return { id: `http:${label}`, kind: "http", label, handler: handler.id, file: handler.file };
}
