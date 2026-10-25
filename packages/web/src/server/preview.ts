import { relative } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { analyze, buildCallTrees, computeSignals, type CallTree, type Facts, type Signals, type Snapshot } from "@catchup/analyzer";
import { diffTrees, evolve, type ChangeSet, type Understanding } from "@catchup/agent";
import { workingRenames } from "@catchup/history";

/**
 * Live preview (Build 7, D58): uncommitted changes as they will land. On each save (debounced) the working tree is
 * analyzed again and HEAD's tree is evolved through it with no Claude call (texts kept, steps re-anchored); the change
 * set against HEAD says what's new. Nothing is stored.
 */

export type PreviewResult = { facts: Facts; snapshot: Snapshot; signals: Signals; trees: CallTree[]; understanding: Understanding; changes: ChangeSet };

export type PreviewState = {
  status: "idle" | "analyzing";
  /** When the last analysis finished, and how long it took. */
  updatedAt: string | null;
  durationMs: number;
  /** Saves seen since the dashboard started. */
  runs: number;
  result: PreviewResult | null;
  error: string | null;
};

const IGNORED = /(^|\/)(node_modules|\.git|\.catchup|dist|build|out|\.next|coverage|\.turbo)(\/|$)/;

export type PreviewInputs = { repoRoot: string; head: { understanding: Understanding; facts: Facts } };

/** Analyzes the working tree against HEAD's tree once (exposed for tests and the first run). */
export async function previewOnce(inputs: PreviewInputs): Promise<PreviewResult> {
  const { facts, snapshot } = await analyze(inputs.repoRoot, "working");
  const trees = buildCallTrees(facts, snapshot);
  const signals = computeSignals({ facts, trees });
  const renames = workingRenames(inputs.repoRoot);
  const { understanding } = await evolve({
    facts,
    snapshot,
    signals,
    trees,
    digest: {},
    digestDir: "",
    maxToolCalls: 0,
    readFile: () => undefined,
    model: inputs.head.understanding.model,
    runnerFor: () => async () => ({ ok: false, error: "the live preview makes no Claude calls" }),
    from: inputs.head,
    renames,
    offline: true,
  });
  const changes = diffTrees(inputs.head, { understanding, facts }, renames);
  return { facts, snapshot, signals, trees, understanding, changes };
}

/** Watches the repository and keeps the latest preview; one analysis at a time, the newest save wins. */
export class Preview {
  private state: PreviewState = { status: "idle", updatedAt: null, durationMs: 0, runs: 0, result: null, error: null };
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  private stopped = false;
  private watcher: FSWatcher | undefined;
  private watching: Promise<void> = Promise.resolve();

  constructor(
    private readonly inputs: PreviewInputs,
    private readonly debounceMs = 700,
  ) {}

  current(): PreviewState {
    return this.state;
  }

  /** Starts watching (and runs once, so the view isn't empty before the first save). */
  start(): void {
    if (this.stopped || this.watcher) return;
    this.watcher = watch(this.inputs.repoRoot, {
      ignoreInitial: true,
      ignored: (path: string) => IGNORED.test(relative(this.inputs.repoRoot, path)),
    });
    this.watcher.on("all", () => this.schedule());
    const watcher = this.watcher;
    this.watching = new Promise((resolve) => watcher.once("ready", () => resolve()));
    void this.run();
  }

  /** Resolves once the watcher has scanned the repository and reports saves. */
  ready(): Promise<void> {
    return this.watching;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.again = false;
    clearTimeout(this.timer);
    await this.watcher?.close();
  }

  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.debounceMs);
  }

  async run(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.state = { ...this.state, status: "analyzing" };
    const started = Date.now();
    try {
      const result = await previewOnce(this.inputs);
      this.state = { status: "idle", updatedAt: new Date().toISOString(), durationMs: Date.now() - started, runs: this.state.runs + 1, result, error: null };
    } catch (e) {
      this.state = { ...this.state, status: "idle", updatedAt: new Date().toISOString(), durationMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }
}
