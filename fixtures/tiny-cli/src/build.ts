import path from "node:path";
import { Worker } from "node:worker_threads";
import { loadConfig } from "./config";

export type Options = { entry: string[]; watch?: boolean; dts?: boolean };

export async function build(options: Options): Promise<void> {
  const config = loadConfig(options);
  if (options.dts) {
    // Runs src/dts.ts in another thread (D52); the path is only known as a string.
    new Worker(path.join(__dirname, `./dts${path.extname(__filename)}`));
  }
  if (options.watch) {
    const { watch } = await import("chokidar");
    watch(config.entry);
  }
}
