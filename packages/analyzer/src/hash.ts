import { createHash } from "node:crypto";
import ts from "typescript";

const printer = ts.createPrinter({ removeComments: true });

/** Hash of a function's code with comments and formatting removed (D18). */
export function hashNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  const printed = ts.isSourceFile(node) ? printer.printFile(node) : printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
  const normalized = printed.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
