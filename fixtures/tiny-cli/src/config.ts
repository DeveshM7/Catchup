import type { Options } from "./build";

export function loadConfig(options: Options): Options {
  return { ...options, entry: options.entry.length > 0 ? options.entry : ["src/index.ts"] };
}

export const defineConfig = (options: Options): Options => options;
