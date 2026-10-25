export type Lang = "typescript" | "javascript";

/** Where a file's code runs: browser, server, or both (Build 1). Absent when nothing tells. */
export type Side = "client" | "server" | "shared";

export type FileFact = { path: string; lang: Lang; loc: number; side?: Side };

export type FunctionFact = {
  id: string;
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  hash: string;
  /** Exported from its module (directly or re-exported). */
  exported?: boolean;
  /** Has a `catch` (its own, not a nested function's) that never throws: a failure there is handled or hidden (D61). */
  swallows?: boolean;
  /** Its own `if`s that leave early (return or throw): guards like "not signed in → 401". A drop is a removed check. */
  guards?: number;
};

/** `to` is a repo-relative file path, or `pkg:<name>` for an installed package. */
export type ImportFact = { from: string; to: string };

export type CallFact = {
  from: string;
  to: string | null;
  line: number;
  /** callback: runs a function value defined elsewhere in our code (a caller's argument, a returned closure). */
  kind: "direct" | "dynamic" | "external" | "callback";
  /** Package name for external calls. */
  target?: string;
  /** The call expression as written, e.g. `redis.client.set`. */
  callee: string;
  conditional?: boolean;
  parallel?: boolean;
  /** Inside a `catch` block. */
  onError?: boolean;
  /** One of several possible targets of the same call (a lookup table of functions). */
  oneOf?: boolean;
  /** `to` is passed as a value here, not called; it runs when the receiver calls it. */
  passed?: boolean;
  /** A tool handed to an AI model call (`streamText({ tools })`): runs only if the model decides to call it (D33). */
  tool?: boolean;
  /** A JSX element: the caller renders `to` (Build 1). */
  render?: boolean;
  /** `to` handles this UI event (`onSubmit`); it runs when the user acts (Build 1). */
  event?: string;
  /** A request from client code to our route: the entry point id `to` belongs to (Build 1). */
  remote?: string;
  /** A message sent to client code that handles it (`{ type: "data-x" }` → `type === "data-x"`) (D42). */
  message?: string;
};

export type EntryPointFact = {
  id: string;
  kind: "http" | "page" | "ui" | "action" | "cli" | "library" | "main" | "event" | "queue" | "cron";
  label: string;
  handler: string;
  file: string;
};

export type Facts = {
  sha: string;
  /** Absent in legacy caches (v1); hashes must be migrated before comparison. */
  hashVersion?: number;
  files: FileFact[];
  functions: FunctionFact[];
  imports: ImportFact[];
  calls: CallFact[];
  entryPoints: EntryPointFact[];
};

export const PKG_PREFIX = "pkg:";
