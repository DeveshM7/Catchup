/** Data the dashboard receives from `catchup open`. Shared by server and UI (types only). */

export type Point = { x: number; y: number };

export type MapNode = {
  id: string;
  label: string;
  description: string;
  /** component: a D19 folder group (full map); part / file: a box on an understanding canvas; external: an outside system. */
  kind: "component" | "external" | "part" | "file";
  files: number;
  functions: number;
  /** Palette slot, stable per top part (or D19 component); externals use their own color. */
  color: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** `main` edges are drawn by default and shape the layout; the rest show only when relevant. */
export type MapEdge = { id: string; from: string; to: string; weight: number; kind: "import" | "uses"; main: boolean; points?: Point[] };

export type MapGraph = { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number };

export type FunctionRef = { id: string; name: string; file: string; startLine: number; endLine: number; component: string };

export type EntryView = { id: string; label: string; systems: string[]; functionCount: number };

/** The full map (D19 components), kept as an option next to the understanding tree. */
export type MapData = { repo: string; sha: string; map: MapGraph; entries: EntryView[] };

export type StepKind = "main" | "check" | "error" | "branch";

/** One node of the understanding tree (D37) as the UI needs it: text from Claude, everything else from code. */
export type NodeView = {
  id: string;
  kind: "system" | "part" | "journey" | "step";
  title: string;
  short: string;
  long: string;
  stepKind?: StepKind;
  depth: number;
  children: string[] | "unopened" | "leaf";
  parent: string | null;
  /** Palette slot: a part's top part; a journey's or step's lane; systems -1. */
  color: number;
  /** Top part ids it runs through (a part: its own top part). */
  parts: string[];
  /** System node ids (`system:<name>`). */
  systems: string[];
  files: string[];
  /** Function ids (look them up in `TreeData.refs`). */
  functions: string[];
  /** Journeys: the entry point (its call tree is the bottom level). */
  entry?: string;
  /** Journeys and steps: the top part holding most of the code it cites. */
  lane?: string;
};

export type FileView = { path: string; loc: number; side?: "client" | "server" | "shared"; flows: number; systems: string[]; functions: string[] };

type Cited = { files: string[]; functions: string[] };
export type ExtrasView = {
  glossary: ({ term: string; meaning: string } & Cited)[];
  startHere: { file: string; why: string }[];
  changes: ({ task: string } & Cited)[];
  surprises: ({ text: string } & Cited)[];
};

export type OtherFlowView = { family: string; entry: string; label: string; members: number; line: string };

/** The understanding tree for one commit, ready to draw. */
export type TreeData = {
  repo: string;
  sha: string;
  model: string;
  summary: string;
  parts: string[];
  journeys: string[];
  systems: string[];
  otherFlows: OtherFlowView[];
  extras: ExtrasView | null;
  nodes: Record<string, NodeView>;
  files: Record<string, FileView>;
  refs: Record<string, FunctionRef>;
};

/** A call tree node as sent to the UI (function nodes carry their ref). */
export type TreeNodeView =
  | {
      kind: "function";
      fn: FunctionRef;
      importance: "important" | "normal" | "noise";
      flags: string[];
      children: TreeNodeView[];
    }
  | { kind: "external" | "dynamic" | "callback"; label: string; importance: "important" | "normal" | "noise"; flags: string[] };

export type TreeView = { entry: string; label: string; partial: boolean; systems: string[]; root: TreeNodeView };

export type SourceView = { id: string; file: string; startLine: number; endLine: number; text: string };

/** Ask (Build 5): a question about the code, optionally about one box or a change (Build 8), with the chat so far. */
export type AskRequest = {
  question: string;
  node?: string;
  history?: { question: string; answer: string }[];
  /** Ask about uncommitted work (`"preview"`) or the commits between two trees. */
  changes?: "preview" | { from: string; to: string };
};

/** One tool call the agent made while answering (shown live). */
export type AskStep = { name: string; target: string; denied?: string };

/** A checked answer: every cite resolved to a box, a function or a file. */
export type AskReply = { answer: string; nodes: string[]; functions: string[]; files: string[]; commits: string[]; steps: AskStep[] };

/** `POST /api/ask` streams these, one JSON object per line. */
export type AskEvent = { type: "step"; step: AskStep } | { type: "answer"; reply: AskReply } | { type: "error"; error: string };

/** A box that changed between two trees (Build 6): what about it changed. */
export type NodeChangeView = { id: string; kind: "system" | "part" | "journey" | "step"; title: string; what: string[] };

export type JourneyChangeView = {
  id: string;
  title: string;
  systemsAdded: string[];
  systemsRemoved: string[];
  stepsAdded: string[];
  stepsRemoved: string[];
  checksRemoved: string[];
  functionsAdded: string[];
  functionsRemoved: string[];
};

/** What changed between two commits, or between HEAD and the working tree (same shape as the agent's ChangeSet). */
export type ChangeSetView = {
  from: string;
  to: string;
  files: { added: string[]; removed: string[]; renamed: { from: string; to: string }[]; changed: string[] };
  entryPoints: { added: string[]; removed: string[] };
  systems: { added: string[]; removed: string[] };
  nodes: { added: NodeChangeView[]; removed: NodeChangeView[]; changed: NodeChangeView[] };
  journeys: JourneyChangeView[];
};

/** The live preview (Build 7): uncommitted changes against HEAD, recomputed on every save. */
export type PreviewView = {
  status: "idle" | "analyzing" | "off";
  updatedAt: string | null;
  durationMs: number;
  runs: number;
  error: string | null;
  head: string;
  changes: ChangeSetView | null;
  /** The working tree's understanding tree (HEAD's, carried through the changes without Claude). */
  tree: TreeData | null;
};

/** A change an Ask question is about (Build 8): its change set and the commits that made it (none for uncommitted work). */
export type ChangeContextView = { label: string; changes: ChangeSetView; commits: { sha: string; date: string; subject: string }[] };

