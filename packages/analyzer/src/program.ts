import { existsSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** One TypeScript program over the repo's source files, used for call resolution ("Go to Definition"). */
export function createProgram(repoRoot: string, sourceFiles: string[]): ts.Program {
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  let options: ts.CompilerOptions = {};
  if (existsSync(tsconfigPath)) {
    const config = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path));
    options = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, repoRoot).options;
  }
  return ts.createProgram(
    sourceFiles.map((file) => join(repoRoot, file)),
    { ...options, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, incremental: false },
  );
}
