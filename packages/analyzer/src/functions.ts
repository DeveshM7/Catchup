import ts from "typescript";
import type { FunctionFact } from "./facts.js";
import { hashNode } from "./hash.js";

export type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function isDefaultExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** Name of an object literal or class expression from where it is assigned; undefined if anonymous. */
function nameFromParent(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
    return objectLiteralName(parent.parent) === undefined ? undefined : propertyName(parent.name);
  }
  if (ts.isPropertyDeclaration(parent)) return propertyName(parent.name);
  if (ts.isExportAssignment(parent)) return "default";
  return undefined;
}

/**
 * `const textHandler = createHandler({ … })` or `new Artifact({ … })` at module level: the config object takes
 * the variable's name (D33).
 */
function factoryConfigName(node: ts.ObjectLiteralExpression): string | undefined {
  const call = node.parent;
  if ((!ts.isCallExpression(call) && !ts.isNewExpression(call)) || !call.arguments?.includes(node)) return undefined;
  const decl = call.parent;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || decl.initializer !== call) return undefined;
  const statement = decl.parent.parent;
  return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent) ? decl.name.text : undefined;
}

function objectLiteralName(node: ts.ObjectLiteralExpression): string | undefined {
  return nameFromParent(node) ?? factoryConfigName(node);
}

function stringArg(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  return first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
}

/**
 * A closure handed to a method call under a string key: `app.get("/x", fn)`, `emitter.on("e", fn)`, or a
 * command chain `cli.command("build").option(…).action(fn)`. Named `<method>:<key>` so it can be an entry point.
 */
export function registrationOf(node: ts.Node): { method: string; key: string } | undefined {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node as ts.Expression)) return undefined;
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const own = stringArg(call);
  if (own !== undefined && call.arguments[0] !== node) return { method: call.expression.name.text, key: own };
  let receiver: ts.Expression = call.expression.expression;
  while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
    if (receiver.expression.name.text === "command") {
      const key = stringArg(receiver);
      return key === undefined ? undefined : { method: "command", key };
    }
    receiver = receiver.expression.expression;
  }
  return undefined;
}

function registrationName(node: ts.Node): string | undefined {
  const reg = registrationOf(node);
  return reg && `${reg.method}:${reg.key}`;
}

/** `const handleSubmit = useCallback(() => …)`, `const Input = forwardRef((props, ref) => …)`: the variable's name. */
function wrappedName(node: ts.Node): string | undefined {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== node || !ts.isIdentifier(call.expression)) return undefined;
  const decl = call.parent;
  return ts.isVariableDeclaration(decl) && decl.initializer === call && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
}

/** JSX tag name as written (`form`, `Button`, `Sidebar.Item`). */
export function jsxTagName(element: ts.JsxOpeningLikeElement): string {
  return element.tagName.getText();
}

/** `<form onSubmit={() => …}>`: named `onSubmit:form`, so a UI event can be an entry point. */
export function jsxEventOf(node: ts.Node): { event: string; tag: string } | undefined {
  const container = node.parent;
  if (!container || !ts.isJsxExpression(container)) return undefined;
  const attr = container.parent;
  if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || !/^on[A-Z]/.test(attr.name.text)) return undefined;
  const element = attr.parent.parent;
  return { event: attr.name.text, tag: jsxTagName(element) };
}

function jsxEventName(node: ts.Node): string | undefined {
  const ev = jsxEventOf(node);
  return ev && `${ev.event}:${ev.tag}`;
}

/** The name segment a function contributes to its ID, or undefined for anonymous callbacks. */
function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? (isDefaultExport(node) ? "default" : undefined);
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    if (ts.isObjectLiteralExpression(node.parent) && objectLiteralName(node.parent) === undefined) return undefined;
    return propertyName(node.name);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return nameFromParent(node) ?? registrationName(node) ?? wrappedName(node) ?? jsxEventName(node);
  }
  return undefined;
}

function containerName(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node)) return node.name?.text ?? (isDefaultExport(node) ? "default" : undefined);
  if (ts.isClassExpression(node)) return node.name?.text ?? nameFromParent(node);
  if (ts.isObjectLiteralExpression(node)) return objectLiteralName(node);
  return undefined;
}

function hasBody(node: FunctionNode): boolean {
  return node.body !== undefined;
}

export function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** A file's top-level code as a function: entry files (CLI bins, an app root) run it on start. */
export const MODULE_UNIT = "(module)";

/** `createRoot(el).render(<App />)` / `ReactDOM.render(<App />, el)` at the top level: the file boots a UI. */
export function isRenderRoot(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((s) => {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) return false;
    const call = s.expression;
    const arg = call.arguments[0];
    return (
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "render" &&
      arg !== undefined &&
      (ts.isJsxElement(arg) || ts.isJsxSelfClosingElement(arg) || ts.isJsxFragment(arg))
    );
  });
}

export type CollectedFunction = { fact: FunctionFact; node: FunctionNode | ts.SourceFile };

/**
 * Named functions in a parsed file. IDs are `<path>#<qualified name>`; repeated names get `~2`, `~3`.
 * With `moduleUnit` (or in an app root), the file's top-level code is one more function, `<path>#(module)`.
 */
export function collectFunctions(path: string, sourceFile: ts.SourceFile, moduleUnit = false): CollectedFunction[] {
  const found: CollectedFunction[] = [];
  const seen = new Map<string, number>();

  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node, scope: string[]): void => {
    const name = functionName(node);
    if (name !== undefined && hasBody(node as FunctionNode)) {
      const qualified = [...scope, name].join(".");
      const count = (seen.get(qualified) ?? 0) + 1;
      seen.set(qualified, count);
      const unique = count === 1 ? qualified : `${qualified}~${count}`;
      found.push({
        node: node as FunctionNode,
        fact: {
          id: `${path}#${unique}`,
          file: path,
          name: unique,
          startLine: lineOf(node.getStart(sourceFile)),
          endLine: lineOf(node.getEnd()),
          hash: hashNode(node, sourceFile),
        },
      });
      ts.forEachChild(node, (child) => visit(child, [...scope, name]));
      return;
    }
    const container = containerName(node);
    const nextScope = container === undefined ? scope : [...scope, container];
    ts.forEachChild(node, (child) => visit(child, nextScope));
  };

  visit(sourceFile, []);
  if (moduleUnit || isRenderRoot(sourceFile)) {
    found.push({
      node: sourceFile,
      fact: {
        id: `${path}#${MODULE_UNIT}`,
        file: path,
        name: MODULE_UNIT,
        startLine: 1,
        endLine: lineOf(sourceFile.getEnd()),
        hash: hashNode(sourceFile, sourceFile),
      },
    });
  }
  return found.sort((a, b) => (a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0));
}

export function extractFunctions(path: string, text: string, moduleUnit = false): FunctionFact[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  return collectFunctions(path, sourceFile, moduleUnit).map((c) => c.fact);
}
