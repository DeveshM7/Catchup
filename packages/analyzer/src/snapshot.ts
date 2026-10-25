export type ComponentKind = "package" | "folder" | "root";

export type Component = {
  id: string;
  name: string;
  kind: ComponentKind;
  files: string[];
  loc: number;
  functionCount: number;
  packages: string[];
};

export type ComponentEdge = { from: string; to: string; weight: number };

export type ExternalSystem = {
  id: string;
  name: string;
  /** A compiler or bundler the code drives (D53); absent: a service it talks to (database, API, AI model). */
  kind?: "tool";
  packages: string[];
  usedBy: string[];
};

export type Snapshot = {
  sha: string;
  components: Component[];
  edges: ComponentEdge[];
  externals: ExternalSystem[];
  summary: { files: number; functions: number; imports: number; components: number; externals: number };
};
