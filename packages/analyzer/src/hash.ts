import { createHash } from "node:crypto";
import ts from "typescript";

const printer = ts.createPrinter({ removeComments: true });
export const FUNCTION_HASH_VERSION = 2;

/** Hash of a function's code with comments and formatting removed (D18). */
export function hashNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  const printed = ts.isSourceFile(node) ? printer.printFile(node) : printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
  const normalized = printed.replace(/\s+/g, " ").trim();
  // Whitespace inside literals is data, not formatting. Keep their exact spelling alongside
  // the normalized structure, including template fragments (but not their expressions).
  const literals: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isLiteralExpression(child) || ts.isTemplateHead(child) || ts.isTemplateMiddle(child) || ts.isTemplateTail(child) || ts.isJsxText(child)) {
      literals.push(child.getText(sourceFile));
    } else ts.forEachChild(child, visit);
  };
  visit(node);
  return createHash("sha256").update(JSON.stringify([normalized, literals])).digest("hex").slice(0, 16);
}
