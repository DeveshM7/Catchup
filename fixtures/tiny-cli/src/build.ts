import { loadConfig } from "./config";

export type Options = { entry: string[]; watch?: boolean };

export async function build(options: Options): Promise<void> {
  const config = loadConfig(options);
  if (options.watch) {
    const { watch } = await import("chokidar");
    watch(config.entry);
  }
}
