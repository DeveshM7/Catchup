import { join } from "node:path";
import type ts from "typescript";
import type { EntryPointFact, ImportFact, Side } from "./facts.js";
import { directiveOf } from "./entrysources.js";
import { MODULE_UNIT } from "./functions.js";

export type SideRoots = {
  /** Files that start client code: `"use client"` files and app roots. */
  client: Set<string>;
  /** Files that start server code: routes, server actions, server-rendered pages and layouts. */
  server: Set<string>;
  /** `"use server"` files: client code importing one calls the server, it doesn't run it. */
  actions: Set<string>;
};

export function sideRoots(program: ts.Program, repoRoot: string, files: string[], entryPoints: EntryPointFact[]): SideRoots {
  const client = new Set<string>();
  const server = new Set<string>();
  const actions = new Set<string>();
  for (const file of files) {
    const sf = program.getSourceFile(join(repoRoot, file));
    const directive = sf && directiveOf(sf);
    if (directive === "use client") client.add(file);
    if (directive === "use server") {
      server.add(file);
      actions.add(file);
    }
  }
  for (const entry of entryPoints) {
    if (entry.kind === "page" && entry.handler.endsWith(`#${MODULE_UNIT}`)) client.add(entry.file);
    else if ((entry.kind === "http" || entry.kind === "action" || entry.kind === "page") && !client.has(entry.file)) server.add(entry.file);
  }
  return { client, server, actions };
}

/**
 * Where each file runs: reached by imports from client roots → client, from server roots → server, both →
 * shared. Server code stops at `"use client"` files (importing one renders it in the browser); client code
 * stops at `"use server"` files (importing one makes requests to the server).
 */
export function fileSides(files: string[], imports: ImportFact[], roots: SideRoots): Map<string, Side> {
  const known = new Set(files);
  const importsOf = new Map<string, string[]>();
  for (const { from, to } of imports) if (known.has(to)) importsOf.set(from, [...(importsOf.get(from) ?? []), to]);
  const reach = (starts: Set<string>, stop: Set<string>): Set<string> => {
    const seen = new Set(starts);
    const queue = [...starts];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      for (const next of importsOf.get(file) ?? []) {
        if (seen.has(next) || stop.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };
  const client = reach(roots.client, roots.actions);
  const server = reach(roots.server, roots.client);
  const sides = new Map<string, Side>();
  for (const file of files) {
    const c = client.has(file);
    const s = server.has(file);
    if (c || s) sides.set(file, c && s ? "shared" : c ? "client" : "server");
  }
  return sides;
}
