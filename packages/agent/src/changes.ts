import type { Facts } from "@catchup/analyzer";
import { externalFor } from "@catchup/analyzer";
import { remapper } from "./evolve.js";
import type { Understanding, UnderstandingNode } from "./tree.js";

/** What changed between two commits (Build 6), computed by code only: files, entry points, systems, tree nodes, journeys. */

export type NodeChange = { id: string; kind: UnderstandingNode["kind"]; title: string; what: string[] };

export type JourneyChange = {
  id: string;
  title: string;
  systemsAdded: string[];
  systemsRemoved: string[];
  stepsAdded: string[];
  stepsRemoved: string[];
  /** Check steps that are gone, or whose code the journey no longer reaches ("a sign-in check was removed"). */
  checksRemoved: string[];
  functionsAdded: string[];
  functionsRemoved: string[];
};

export type ChangeSet = {
  from: string;
  to: string;
  files: { added: string[]; removed: string[]; renamed: { from: string; to: string }[]; changed: string[] };
  entryPoints: { added: string[]; removed: string[] };
  systems: { added: string[]; removed: string[] };
  nodes: { added: NodeChange[]; removed: NodeChange[]; changed: NodeChange[] };
  journeys: JourneyChange[];
};

export type Side = { understanding: Understanding; facts: Facts };

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const minus = (a: Iterable<string>, b: Iterable<string>): string[] => {
  const drop = new Set(b);
  return sorted([...a].filter((x) => !drop.has(x)));
};

/** Outside systems the facts call (by name). */
function systemsOf(facts: Facts): string[] {
  return sorted(facts.calls.flatMap((c) => (c.kind === "external" && c.target !== undefined ? (externalFor(c.target)?.name ?? []) : [])));
}

function filesChanged(a: Facts, b: Facts, renames: Map<string, string>): ChangeSet["files"] {
  const before = new Set(a.files.map((f) => f.path));
  const after = new Set(b.files.map((f) => f.path));
  const renamed = [...renames].filter(([from, to]) => before.has(from) && after.has(to)).map(([from, to]) => ({ from, to }));
  const movedFrom = new Set(renamed.map((r) => r.from));
  const movedTo = new Set(renamed.map((r) => r.to));
  // A file changed when the bodies of its functions did (formatting and comments don't count, D18).
  const bodies = (facts: Facts, file: string): string =>
    facts.functions
      .filter((f) => f.file === file)
      .map((f) => `${f.name}:${f.hash}`)
      .sort()
      .join(",");
  const changed = [...after].filter((f) => {
    const old = [...renames].find(([, to]) => to === f)?.[0] ?? f;
    return before.has(old) && bodies(a, old) !== bodies(b, f);
  });
  return {
    added: sorted([...after].filter((f) => !before.has(f) && !movedTo.has(f))),
    removed: sorted([...before].filter((f) => !after.has(f) && !movedFrom.has(f))),
    renamed: renamed.sort((x, y) => (x.from < y.from ? -1 : 1)),
    changed: sorted(changed),
  };
}

/** How a node differs once A's anchor is read through the renames: its text, its code, its children, its systems. */
function nodeDiff(a: UnderstandingNode, b: UnderstandingNode, remapFile: (f: string) => string | undefined, remapFn: (id: string) => string | undefined): string[] {
  const what: string[] = [];
  if (a.title !== b.title || a.short !== b.short || a.long !== b.long) what.push("text");
  const filesA = sorted(a.anchor.files.flatMap((f) => remapFile(f) ?? [`(gone) ${f}`]));
  const fnsA = sorted(a.anchor.functions.flatMap((f) => remapFn(f) ?? [`(gone) ${f}`]));
  if (filesA.join() !== sorted(b.anchor.files).join() || fnsA.join() !== sorted(b.anchor.functions).join()) what.push("code");
  if (JSON.stringify(a.children) !== JSON.stringify(b.children) && Array.isArray(a.children) && Array.isArray(b.children)) what.push("children");
  if (sorted(a.systems ?? []).join() !== sorted(b.systems ?? []).join()) what.push("systems");
  return what;
}

const change = (node: UnderstandingNode, what: string[] = []): NodeChange => ({ id: node.id, kind: node.kind, title: node.title, what });

export function diffTrees(a: Side, b: Side, renames: Map<string, string>): ChangeSet {
  const map = remapper(a.facts, b.facts, renames);
  const guardsA = new Map(a.facts.functions.map((f) => [f.id, f.guards ?? 0]));
  const guardsB = new Map(b.facts.functions.map((f) => [f.id, f.guards ?? 0]));
  const ua = a.understanding;
  const ub = b.understanding;
  const idsA = Object.keys(ua.nodes);
  const idsB = Object.keys(ub.nodes);
  const added = minus(idsB, idsA).map((id) => change(ub.nodes[id]!));
  const removed = minus(idsA, idsB).map((id) => change(ua.nodes[id]!));
  const changed = idsA
    .filter((id) => ub.nodes[id] !== undefined)
    .flatMap((id) => {
      const what = nodeDiff(ua.nodes[id]!, ub.nodes[id]!, map.file, map.fn);
      return what.length ? [change(ub.nodes[id]!, what)] : [];
    });

  const journeys = ua.journeys.flatMap((id): JourneyChange[] => {
    const ja = ua.nodes[id];
    const jb = ub.nodes[id];
    if (!ja) return [];
    const stepsOf = (u: Understanding, j: UnderstandingNode | undefined): UnderstandingNode[] =>
      j && Array.isArray(j.children) ? j.children.flatMap((c) => u.nodes[c] ?? []) : [];
    const stepsA = stepsOf(ua, ja);
    const stepsB = stepsOf(ub, jb);
    const fnsA = ja.anchor.functions.map((f) => map.fn(f) ?? f);
    const fnsB = jb?.anchor.functions ?? [];
    const reached = new Set(fnsB);
    // A check is gone when its step is, when the step that took its place isn't a check, when code it cited no longer
    // runs, or when a function it cites has fewer early exits ("if not the owner → 403" deleted from a handler).
    const checksRemoved = stepsA
      .filter((s) => s.stepKind === "check")
      .filter((s) => {
        const next = stepsB.find((t) => t.id === s.id);
        return (
          !next ||
          next.stepKind !== "check" ||
          s.anchor.functions.some((f) => !reached.has(map.fn(f) ?? f)) ||
          s.anchor.functions.some((f) => (guardsA.get(f) ?? 0) > (guardsB.get(map.fn(f) ?? f) ?? 0))
        );
      })
      .map((s) => s.title);
    const entry: JourneyChange = {
      id,
      title: (jb ?? ja).title,
      systemsAdded: minus(jb?.systems ?? [], ja.systems ?? []),
      systemsRemoved: minus(ja.systems ?? [], jb?.systems ?? []),
      stepsAdded: stepsB.filter((s) => !stepsA.some((t) => t.id === s.id)).map((s) => s.title),
      stepsRemoved: stepsA.filter((s) => !stepsB.some((t) => t.id === s.id)).map((s) => s.title),
      checksRemoved,
      functionsAdded: minus(fnsB, fnsA),
      functionsRemoved: minus(fnsA, fnsB),
    };
    const quiet = Object.entries(entry).every(([k, v]) => k === "id" || k === "title" || (Array.isArray(v) && v.length === 0));
    return quiet ? [] : [entry];
  });

  const labels = (facts: Facts): string[] => facts.entryPoints.map((e) => e.label);
  return {
    from: a.facts.sha,
    to: b.facts.sha,
    files: filesChanged(a.facts, b.facts, renames),
    entryPoints: { added: minus(labels(b.facts), labels(a.facts)), removed: minus(labels(a.facts), labels(b.facts)) },
    systems: { added: minus(systemsOf(b.facts), systemsOf(a.facts)), removed: minus(systemsOf(a.facts), systemsOf(b.facts)) },
    nodes: { added, removed, changed },
    journeys,
  };
}

/** Plain-text summary of a change set (for the terminal and for prompts). */
export function formatChanges(c: ChangeSet): string {
  const list = (label: string, items: string[]): string[] => (items.length ? [`${label}: ${items.join(", ")}`] : []);
  return [
    `${c.from.slice(0, 9)} → ${c.to.slice(0, 9)}`,
    ...list("Files added", c.files.added),
    ...list("Files removed", c.files.removed),
    ...list("Files renamed", c.files.renamed.map((r) => `${r.from} → ${r.to}`)),
    ...list("Files changed", c.files.changed),
    ...list("Entry points added", c.entryPoints.added),
    ...list("Entry points removed", c.entryPoints.removed),
    ...list("Outside systems added", c.systems.added),
    ...list("Outside systems removed", c.systems.removed),
    ...c.journeys.flatMap((j) => [
      `Journey "${j.title}":`,
      ...list("  now uses", j.systemsAdded),
      ...list("  no longer uses", j.systemsRemoved),
      ...list("  checks removed", j.checksRemoved),
      ...list("  steps added", j.stepsAdded),
      ...list("  steps removed", j.stepsRemoved),
      ...list("  no longer runs", j.functionsRemoved),
      ...list("  now runs", j.functionsAdded),
    ]),
    ...list("Boxes added", c.nodes.added.map((n) => n.title)),
    ...list("Boxes removed", c.nodes.removed.map((n) => n.title)),
    ...list("Boxes changed", c.nodes.changed.map((n) => `${n.title} (${n.what.join(", ")})`)),
  ].join("\n");
}

