import { cac } from "cac";
import { build } from "./build";
import { clean } from "./clean";

export async function main(): Promise<void> {
  const cli = cac("tc");
  cli
    .command("[...files]", "Build files")
    .option("--watch", "Watch mode")
    .action(async (files: string[], flags: { watch?: boolean }) => {
      await build({ entry: files, watch: flags.watch });
    });
  cli.command("clean", "Remove output").action(clean);
  cli.parse();
}
