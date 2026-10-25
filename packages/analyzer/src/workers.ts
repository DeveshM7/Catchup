import { posix } from "node:path";
import ts from "typescript";

/** Worker threads (D52): `new Worker(<path to our file>)` runs that file's top-level code in another thread. */

const WORKER_MODULES = new Set(["worker_threads", "node:worker_threads"]);
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Local names bound to `Worker` from `worker_threads` in this file (`import { Worker as W } …`). */
function workerNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !WORKER_MODULES.has(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === "Worker") names.add(el.name.text);
    }
  }
  return names;
}

/** Relative-looking string parts written in an expression: `"./rollup"` in `path.join(__dirname, \`./rollup${ext}\`)`. */
function writtenPaths(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    const text = ts.isStringLiteralLike(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text : undefined;
    if (text !== undefined && text.length > 0 && !text.startsWith("/") && !text.includes(":")) found.push(text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Our source file a written path names, relative to the file that writes it; extensions may differ (`.js` → `.ts`). */
function resolveSource(fromFile: string, written: string, sourceFiles: Set<string>): string | undefined {
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), written));
  const stem = joined.replace(/\.[mc]?[jt]sx?$/, "");
  return [joined, ...SOURCE_EXTS.map((ext) => stem + ext)].find((f) => sourceFiles.has(f));
}

/** The source file a `new Worker(…)` expression starts, if it is one of ours. */
function workerTarget(node: ts.NewExpression, fromFile: string, names: Set<string>, sourceFiles: Set<string>): string | undefined {
  if (!ts.isIdentifier(node.expression) || !names.has(node.expression.text)) return undefined;
  const arg = node.arguments?.[0];
  if (!arg) return undefined;
  for (const written of writtenPaths(arg)) {
    const file = resolveSource(fromFile, written, sourceFiles);
    if (file !== undefined && file !== fromFile) return file;
  }
  return undefined;
}

/** Every `new Worker(…)` in a file and the source file it starts. */
export function workerStarts(path: string, sourceFile: ts.SourceFile, sourceFiles: Set<string>): { node: ts.NewExpression; file: string }[] {
  const names = workerNames(sourceFile);
  if (names.size === 0) return [];
  const found: { node: ts.NewExpression; file: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const file = workerTarget(node, path, names, sourceFiles);
      if (file !== undefined) found.push({ node, file });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

