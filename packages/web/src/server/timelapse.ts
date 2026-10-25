import type { Facts, Signals } from "@catchup/analyzer";
import type { Caption, ChangeSet, Understanding } from "@catchup/agent";
import type { FrameNode, MapEdge, MapNode, TimelapseFrame, TimelapseView } from "../shared/types.js";
import { markMain } from "./data.js";
import { layoutMap } from "./layout.js";
import { BOX } from "./understanding.js";

/** Timelapse frames and the union layout (Build 9, D60): deterministic, from stored trees, change sets and captions. */

export type Checkpoint = { commit: { sha: string; date: string; subject: string; tags: string[] }; understanding: Understanding; facts: Facts; signals: Signals };
export type Step = { changes: ChangeSet; caption: Caption; commits: { sha: string; subject: string }[] };

const fileOf = (fn: string): string => fn.slice(0, fn.indexOf("#"));
const systemId = (name: string): string => `system:${name}`;

type FrameGraph = { nodes: Map<string, { title: string; short: string; kind: "part" | "external"; color: number }>; links: Map<string, number> };

/** Boxes in two frames are the same box when their files overlap this much (Jaccard, through renames). */
export const SAME_BOX = 0.4;

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Each checkpoint's top-part ids → the timelapse's ids: a part keeps the id it had in the frame before when it is the
 * same id or its files overlap that part's by ≥ SAME_BOX (a tree written afresh still lands on the same box, D60).
 */
function canonicalIds(checkpoints: Checkpoint[], steps: Step[]): Map<string, string>[] {
  const result: Map<string, string>[] = [];
  const taken = new Set<string>();
  checkpoints.forEach((cp, i) => {
    const alias = new Map<string, string>();
    const u = cp.understanding;
    if (i === 0) {
      for (const id of u.parts) alias.set(id, id);
    } else {
      const prevCp = checkpoints[i - 1]!;
      const prevAlias = result[i - 1]!;
      const renames = new Map((steps[i - 1]?.changes.files.renamed ?? []).map((r) => [r.from, r.to] as const));
      const prevParts = prevCp.understanding.parts.map((id) => ({
        id,
        canonical: prevAlias.get(id)!,
        files: new Set((prevCp.understanding.nodes[id]?.anchor.files ?? []).map((f) => renames.get(f) ?? f)),
      }));
      const used = new Set<string>();
      for (const id of u.parts) {
        const same = prevParts.find((p) => p.id === id && !used.has(p.canonical));
        if (same) {
          alias.set(id, same.canonical);
          used.add(same.canonical);
        }
      }
      for (const id of u.parts) {
        if (alias.has(id)) continue;
        const files = new Set(u.nodes[id]?.anchor.files ?? []);
        let best: { canonical: string; score: number } | undefined;
        for (const p of prevParts) {
          if (used.has(p.canonical)) continue;
          const score = jaccard(files, p.files);
          if (score >= SAME_BOX && (!best || score > best.score)) best = { canonical: p.canonical, score };
        }
        let canonical = best?.canonical;
        if (canonical === undefined) {
          // A new box; an id that belonged to another box earlier gets a suffix so the two never share a place.
          canonical = id;
          for (let n = 2; taken.has(canonical) || used.has(canonical); n += 1) canonical = `${id}~${n}`;
        }
        alias.set(id, canonical);
        used.add(canonical);
      }
    }
    for (const c of alias.values()) taken.add(c);
    result.push(alias);
  });
  return result;
}

/** A checkpoint's top parts and outside systems, linked by the calls and imports that cross between parts. */
function frameGraph(cp: Checkpoint, alias: Map<string, string>, colorOf: (id: string) => number): FrameGraph {
  const u = cp.understanding;
  const nodes: FrameGraph["nodes"] = new Map();
  const owner = new Map<string, string>();
  for (const local of u.parts) {
    const part = u.nodes[local];
    const id = alias.get(local) ?? local;
    if (!part) continue;
    nodes.set(id, { title: part.title, short: part.short, kind: "part", color: colorOf(id) });
    for (const f of part.anchor.files) owner.set(f, id);
  }
  const links = new Map<string, number>();
  const link = (a: string | undefined, b: string | undefined): void => {
    if (a === undefined || b === undefined || a === b) return;
    links.set(`${a}->${b}`, (links.get(`${a}->${b}`) ?? 0) + 1);
  };
  for (const call of cp.facts.calls) if (call.to !== null) link(owner.get(fileOf(call.from)), owner.get(fileOf(call.to)));
  for (const imp of cp.facts.imports) link(owner.get(imp.from), owner.get(imp.to));
  for (const [file, part] of owner) {
    for (const name of cp.signals.files[file]?.systems ?? []) {
      nodes.set(systemId(name), { title: name, short: "outside system", kind: "external", color: -1 });
      links.set(`${part}->${systemId(name)}`, Math.max(links.get(`${part}->${systemId(name)}`) ?? 0, 1));
    }
  }
  return { nodes, links };
}

export async function buildTimelapse(checkpoints: Checkpoint[], steps: Step[]): Promise<TimelapseView> {
  // One color per top part for the whole timelapse: first come, first served.
  const slots = new Map<string, number>();
  const colorOf = (id: string): number => {
    if (!slots.has(id)) slots.set(id, slots.size);
    return slots.get(id)!;
  };
  const aliases = canonicalIds(checkpoints, steps);
  const graphs = checkpoints.map((cp, i) => frameGraph(cp, aliases[i]!, colorOf));

  // Union: every box that ever exists (latest title), every link with its strongest weight.
  const union = new Map<string, Omit<MapNode, "x" | "y" | "width" | "height">>();
  const weights = new Map<string, number>();
  for (const g of graphs) {
    for (const [id, n] of g.nodes) union.set(id, { id, label: n.title, description: n.short, kind: n.kind, files: 0, functions: 0, color: n.color });
    for (const [id, w] of g.links) weights.set(id, Math.max(weights.get(id) ?? 0, w));
  }
  const edges: MapEdge[] = [...weights].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, weight]) => {
    const [from, to] = id.split("->") as [string, string];
    return { id, from, to, weight, kind: to.startsWith("system:") ? "uses" : "import", main: false };
  });
  const nodes = [...union.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const layout = await layoutMap(nodes, markMain(edges), (n) => BOX[n.kind === "external" ? "external" : "part"]);
  const main = new Set(layout.edges.filter((e) => e.main).map((e) => e.id));

  const frames = checkpoints.map((cp, i): TimelapseFrame => {
    const g = graphs[i]!;
    const prev = i > 0 ? graphs[i - 1] : undefined;
    const step = i > 0 ? steps[i - 1] : undefined;
    const changed = new Set((step?.changes.nodes.changed ?? []).map((n) => aliases[i]!.get(n.id) ?? n.id));
    const frameNodes: FrameNode[] = [...g.nodes].map(([id, n]) => {
      const before = prev?.nodes.get(id);
      const status = prev && !before ? "added" : changed.has(id) || (before && (before.title !== n.title || before.short !== n.short)) ? "changed" : "same";
      return { id, title: n.title, short: n.short, status };
    });
    const u = cp.understanding;
    return {
      ...cp.commit,
      nodes: frameNodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
      removed: prev ? [...prev.nodes.keys()].filter((id) => !g.nodes.has(id)).sort() : [],
      edges: [...g.links.keys()].filter((id) => main.has(id) || id.includes("->system:")).sort(),
      summary: u.summary,
      journeys: u.journeys.flatMap((id) => {
        const j = u.nodes[id];
        return j ? [{ title: j.title, steps: Array.isArray(j.children) ? j.children.flatMap((c) => u.nodes[c]?.title ?? []) : [] }] : [];
      }),
      ...(step
        ? {
            step: {
              caption: step.caption.caption,
              impact: step.caption.impact,
              commits: step.caption.commits.map((sha) => ({ sha, subject: step.commits.find((c) => c.sha === sha)?.subject ?? "" })),
              commitCount: step.commits.length,
              files: { added: step.changes.files.added.length, removed: step.changes.files.removed.length, changed: step.changes.files.changed.length, renamed: step.changes.files.renamed.length },
              entryPoints: step.changes.entryPoints,
              systems: step.changes.systems,
            },
          }
        : {}),
    };
  });
  return { from: checkpoints[0]?.commit.sha ?? "", to: checkpoints.at(-1)?.commit.sha ?? "", layout, frames };
}
