import { describe, expect, it } from "vitest";
import type { Facts, Signals } from "@catchup/analyzer";
import type { ChangeSet, Understanding, UnderstandingNode } from "@catchup/agent";
import { buildTimelapse, type Checkpoint, type Step } from "./server/timelapse.js";

const part = (id: string, title: string, files: string[]): UnderstandingNode => ({ id, kind: "part", title, short: `${title}.`, long: "", anchor: { files, functions: [] }, children: "leaf", depth: 1, basis: "b" });

function checkpoint(sha: string, parts: UnderstandingNode[], calls: [string, string][] = [], systems: Record<string, string[]> = {}): Checkpoint {
  const files = [...new Set(parts.flatMap((p) => p.anchor.files))];
  const understanding: Understanding = { sha, model: "m", summary: `App at ${sha}.`, parts: parts.map((p) => p.id), journeys: [], systems: [], otherFlows: [], nodes: Object.fromEntries(parts.map((p) => [p.id, p])), basis: "b" };
  const facts: Facts = { sha, files: files.map((path) => ({ path, lang: "typescript", loc: 1 })), functions: [], imports: [], calls: calls.map(([a, b]) => ({ from: `${a}#f`, to: `${b}#g`, line: 1, kind: "direct", callee: "g" })), entryPoints: [] };
  const signals = { sha, functions: {}, families: [], files: Object.fromEntries(files.map((f) => [f, { flows: 0, systems: systems[f] ?? [], fanIn: 0, churn: 0, readme: false, exported: false, loc: 1 }])) } as unknown as Signals;
  return { commit: { sha, date: `2024-0${sha.length}-01T00:00:00Z`, subject: `commit ${sha}`, tags: [] }, understanding, facts, signals };
}

const noChanges = (from: string, to: string, renamed: { from: string; to: string }[] = []): ChangeSet => ({
  from, to, files: { added: [], removed: [], renamed, changed: [] }, entryPoints: { added: [], removed: [] }, systems: { added: [], removed: [] }, nodes: { added: [], removed: [], changed: [] }, journeys: [],
});
const step = (from: string, to: string, renamed: { from: string; to: string }[] = []): Step => ({ changes: noChanges(from, to, renamed), caption: { caption: `${from}→${to}`, impact: "i", commits: [] }, commits: [] });

describe("timelapse frames (Build 9)", () => {
  it("keeps a box's identity across a tree written afresh, through renames, and draws every frame on one layout", async () => {
    const one = checkpoint("a", [part("part:api", "API", ["api/a.ts", "api/b.ts"]), part("part:db", "DB", ["db/q.ts"])], [["api/a.ts", "db/q.ts"]], { "db/q.ts": ["Postgres"] });
    // A fresh tree: the API part now has another id and title but mostly the same files (one renamed).
    const two = checkpoint("bb", [part("part:server", "Server", ["api/a.ts", "api/route.ts", "api/c.ts"]), part("part:db", "DB", ["db/q.ts"]), part("part:ui", "UI", ["ui/x.tsx"])], [["ui/x.tsx", "api/a.ts"]]);
    const three = checkpoint("ccc", [part("part:server", "Server", ["api/a.ts", "api/route.ts", "api/c.ts"]), part("part:ui", "UI", ["ui/x.tsx"])]);
    const view = await buildTimelapse([one, two, three], [step("a", "bb", [{ from: "api/b.ts", to: "api/route.ts" }]), step("bb", "ccc")]);

    const [f1, f2, f3] = view.frames;
    expect(f1!.nodes.map((n) => [n.id, n.status])).toEqual([["part:api", "same"], ["part:db", "same"], ["system:Postgres", "same"]]);
    expect(f2!.nodes.map((n) => [n.id, n.title, n.status])).toEqual([
      ["part:api", "Server", "changed"],
      ["part:db", "DB", "same"],
      ["part:ui", "UI", "added"],
    ]);
    expect(f2!.removed).toEqual(["system:Postgres"]);
    expect(f3!.removed).toEqual(["part:db"]);
    expect(f3!.nodes.find((n) => n.id === "part:api")?.status).toBe("same");
    expect(f2!.step?.caption).toBe("a→bb");
    // One layout over the union: every box that ever exists has one fixed place.
    expect(view.layout.nodes.map((n) => n.id).sort()).toEqual(["part:api", "part:db", "part:ui", "system:Postgres"]);
    expect(f2!.edges).toContain("part:ui->part:api");
    const again = await buildTimelapse([one, two, three], [step("a", "bb", [{ from: "api/b.ts", to: "api/route.ts" }]), step("bb", "ccc")]);
    expect(again.layout).toEqual(view.layout);
  });
});
