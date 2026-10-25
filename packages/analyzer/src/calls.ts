import { isBuiltin } from "node:module";
import { relative, sep } from "node:path";
import ts from "typescript";
import type { CallFact, ImportFact, Side } from "./facts.js";
import { PKG_PREFIX } from "./facts.js";
import { externalFor, packageOfSpecifier } from "./externals.js";
import { collectFunctions, jsxEventOf, jsxTagName, registrationOf, type FunctionNode } from "./functions.js";
import { matchRoutes, PLACEHOLDER, type Route } from "./links.js";
import { packageName } from "./imports.js";
import { compareStrings } from "./sort.js";

type Context = {
  checker: ts.TypeChecker;
  repoRoot: string;
  sourceFiles: Set<string>;
  idOfNode: Map<ts.Node, string>;
  localPrefixes: string[];
  /** file → packages it imports that map to an external system */
  systemPackagesOf: Map<string, string[]>;
  traceCache: Map<ts.Symbol, Map<string | symbol, Trace>>;
  /** Our HTTP routes, for client → server links. */
  routes: Route[];
  /** Files that run only on the server: a URL written there is a route or a redirect, not a request to us. */
  serverFiles: Set<string>;
  /** Package → our routes written into a call to it (`useChat({ api: "/api/chat" })`): it requests them later. */
  configured: Map<string, Route[]>;
};

type Resolution = Pick<CallFact, "to" | "kind" | "target" | "oneOf">;

const BUILTIN = Symbol("builtin");
type Origin = string | typeof BUILTIN | undefined;

const PROMISE_COMBINATOR = /^Promise\.(all|allSettled|race|any)$/;
const MAX_CALLEE_LENGTH = 80;

function repoPath(ctx: Context, fileName: string): string | undefined {
  const path = relative(ctx.repoRoot, fileName).split(sep).join("/");
  return path.startsWith("..") ? undefined : path;
}

/** Package that owns a declaration file outside the repo's sources; BUILTIN for TS libs and Node types. */
function packageOfFile(fileName: string): Origin {
  const normalized = fileName.split(sep).join("/");
  const at = normalized.lastIndexOf("/node_modules/");
  if (at === -1) return BUILTIN;
  let pkg = packageName(normalized.slice(at + "/node_modules/".length));
  if (pkg.startsWith("@types/")) pkg = pkg.slice("@types/".length).replace("__", "/");
  return pkg === "typescript" || pkg === "node" || isBuiltin(pkg) ? BUILTIN : pkg;
}

function isLocalSpecifier(ctx: Context, spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/") || ctx.localPrefixes.some((p) => spec.startsWith(p));
}

function importSpecifierOf(decl: ts.Declaration): string | undefined {
  let node: ts.Node = decl;
  while (!ts.isSourceFile(node)) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      return ts.isStringLiteral(expr) ? expr.text : undefined;
    }
    node = node.parent;
  }
  return undefined;
}

function aliased(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    const target = checker.getAliasedSymbol(symbol);
    return target.declarations?.length ? target : symbol;
  }
  return symbol;
}

/** The leftmost identifier of `a.b().c[d].e`, if any. */
function rootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let node: ts.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(node)) return node;
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      node = node.expression;
      continue;
    }
    return undefined;
  }
}

function isModuleLevel(decl: ts.Node): boolean {
  let node = decl.parent;
  while (node && !ts.isSourceFile(node)) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
    node = node.parent;
  }
  return true;
}

/** Leftmost identifier of a type name like `z.ZodType`, `RedisClientType` or `Helpers["send"]` (a union's first). */
function typeRootIdentifier(type: ts.TypeNode | undefined): ts.Identifier | undefined {
  if (type && ts.isIndexedAccessTypeNode(type)) return typeRootIdentifier(type.objectType);
  if (type && ts.isUnionTypeNode(type)) return type.types.map(typeRootIdentifier).find((t) => t !== undefined);
  if (type && ts.isParenthesizedTypeNode(type)) return typeRootIdentifier(type.type);
  if (!type || !ts.isTypeReferenceNode(type)) return undefined;
  let name: ts.EntityName = type.typeName;
  while (ts.isQualifiedName(name)) name = name.left;
  return name;
}

/**
 * Which package a value comes from, when its type can't be resolved (no node_modules):
 * follow imports, `const x = pkgThing()` initializers and declared types (`client: RedisClientType`);
 * as a last resort, a module-level value in a file that imports exactly one external system is
 * attributed to that system (D20).
 */
function originOf(ctx: Context, ident: ts.Identifier, depth = 0): Origin {
  if (depth > 4) return undefined;
  const direct = ctx.checker.getSymbolAtLocation(ident);
  const first = direct?.declarations?.[0];
  if (first) {
    const spec = importSpecifierOf(first);
    if (spec !== undefined && !isLocalSpecifier(ctx, spec)) {
      return isBuiltin(spec) ? BUILTIN : packageOfSpecifier(spec);
    }
  }
  const decl = aliased(ctx.checker, direct)?.declarations?.[0];
  return decl ? originOfDeclaration(ctx, decl, depth) : undefined;
}

function originOfDeclaration(ctx: Context, decl: ts.Declaration, depth: number): Origin {
  if (importSpecifierOf(decl) !== undefined) return undefined;
  const file = repoPath(ctx, decl.getSourceFile().fileName);
  if (file === undefined || !ctx.sourceFiles.has(file)) return packageOfFile(decl.getSourceFile().fileName);

  const typed =
    ts.isParameter(decl) || ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)
      ? typeRootIdentifier(decl.type)
      : undefined;
  if (typed) {
    const origin = originOf(ctx, typed, depth + 1);
    if (origin !== undefined) return origin;
  }
  const initializer =
    ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)
      ? decl.initializer
      : ts.isExportAssignment(decl)
        ? decl.expression
        : undefined;
  const root = initializer ? rootIdentifier(initializer) : undefined;
  if (root) {
    const origin = originOf(ctx, root, depth + 1);
    if (origin !== undefined) return origin;
  }
  if (isModuleLevel(decl)) {
    const systems = ctx.systemPackagesOf.get(file) ?? [];
    const names = new Set(systems.map((pkg) => externalFor(pkg)?.id));
    if (names.size === 1) return systems[0];
  }
  return undefined;
}

/** Origin of the receiver chain's start: an identifier, or `this.field`. */
function originOfReceiver(ctx: Context, expr: ts.Expression): Origin {
  const root = rootIdentifier(expr);
  if (root) return originOf(ctx, root);
  let node: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isNonNullExpression(node)) {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const decl = ctx.checker.getSymbolAtLocation(node.name)?.declarations?.[0];
      return decl ? originOfDeclaration(ctx, decl, 0) : undefined;
    }
    node = node.expression;
  }
  return undefined;
}

export function functionNodeOf(decl: ts.Declaration): ts.Node | undefined {
  if (ts.isFunctionLike(decl)) return decl;
  if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
    return decl.initializer;
  }
  if (ts.isExportAssignment(decl)) return decl.expression;
  if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) return decl.members.find(ts.isConstructorDeclaration);
  return undefined;
}

/**
 * Resolve a function held in a value (e.g. `const { rawQuery } = prisma; rawQuery()`) through its type's
 * call signature. An anonymous closure declared in our code resolves to nothing to record: its calls are
 * already attributed to the named function that contains it.
 */
function resolveByType(ctx: Context, expr: ts.Expression): Resolution | undefined | "unknown" {
  const signatures = ctx.checker.getTypeAtLocation(expr).getCallSignatures();
  for (const signature of signatures) {
    const decl = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
    if (!decl || !ts.isFunctionLike(decl)) continue;
    const id = ctx.idOfNode.get(decl);
    if (id !== undefined) return { to: id, kind: "direct" };
    const file = repoPath(ctx, decl.getSourceFile().fileName);
    const hasBody = "body" in decl && decl.body !== undefined;
    if (hasBody && file !== undefined && ctx.sourceFiles.has(file)) return undefined;
  }
  return "unknown";
}

/** Where a called function value can come from (D22). */
type Trace = {
  /** Named functions in our code that the value may be. */
  ids: Set<string>;
  /** A function supplied from elsewhere: a caller's argument, or an anonymous closure whose calls are already recorded where it is written. */
  callback: boolean;
  /** Some source couldn't be followed: the target is only known at runtime. */
  unknown: boolean;
  /** Packages the value may come from (`(a ? startOfDay : startOfWeek)(d)` with date-fns imports). */
  packages: Set<string>;
};

const ALL_PROPERTIES = Symbol("all");
type PropertyKey = string | typeof ALL_PROPERTIES;
const MAX_TRACE_DEPTH = 10;

function emptyTrace(): Trace {
  return { ids: new Set(), callback: false, unknown: false, packages: new Set() };
}

function merge(into: Trace, from: Trace): Trace {
  for (const id of from.ids) into.ids.add(id);
  for (const pkg of from.packages) into.packages.add(pkg);
  into.callback ||= from.callback;
  into.unknown ||= from.unknown;
  return into;
}

const unknownTrace = (): Trace => ({ ...emptyTrace(), unknown: true });
const callbackTrace = (): Trace => ({ ...emptyTrace(), callback: true });

function unwrap(expr: ts.Expression): ts.Expression {
  let node = expr;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function traceFunctionExpression(ctx: Context, fn: ts.Node): Trace {
  const id = ctx.idOfNode.get(fn);
  return id !== undefined ? { ...emptyTrace(), ids: new Set([id]) } : callbackTrace();
}

/** The local function a call invokes, if it is one of ours. */
function localCallee(ctx: Context, call: ts.CallExpression): ts.SignatureDeclaration | undefined {
  const expr = call.expression;
  const nameNode = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isIdentifier(expr) ? expr : undefined;
  if (!nameNode) return undefined;
  for (const decl of aliased(ctx.checker, ctx.checker.getSymbolAtLocation(nameNode))?.declarations ?? []) {
    const fn = functionNodeOf(decl);
    if (fn && ctx.idOfNode.has(fn) && ts.isFunctionLike(fn)) return fn;
  }
  return undefined;
}

/** Expressions a function returns (a concise arrow body counts). */
function returnedExpressions(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = "body" in fn ? fn.body : undefined;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body as ts.Expression];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/** Right-hand sides of `name = …` inside the scope that declares a `let`/`var`. */
function assignmentsTo(ctx: Context, decl: ts.VariableDeclaration, symbol: ts.Symbol): ts.Expression[] {
  if (ts.isVariableDeclarationList(decl.parent) && decl.parent.flags & ts.NodeFlags.Const) return [];
  let scope: ts.Node = decl.parent;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) scope = scope.parent;
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ctx.checker.getSymbolAtLocation(node.left) === symbol
    ) {
      found.push(node.right);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

function traceSymbol(ctx: Context, symbolIn: ts.Symbol | undefined, key: PropertyKey | undefined, depth: number): Trace {
  const symbol = aliased(ctx.checker, symbolIn);
  const decl = symbol?.declarations?.[0];
  if (!symbol || !decl || depth > MAX_TRACE_DEPTH) return unknownTrace();
  const cacheKey = key ?? "";
  const cached = ctx.traceCache.get(symbol)?.get(cacheKey);
  if (cached) return cached;
  const trace = traceDeclaration(ctx, symbol, decl, key, depth);
  ctx.traceCache.set(symbol, (ctx.traceCache.get(symbol) ?? new Map<PropertyKey, Trace>()).set(cacheKey, trace));
  return trace;
}

function traceDeclaration(ctx: Context, symbol: ts.Symbol, decl: ts.Declaration, key: PropertyKey | undefined, depth: number): Trace {
  const spec = importSpecifierOf(decl);
  if (spec !== undefined && !isLocalSpecifier(ctx, spec)) {
    return isBuiltin(spec) ? unknownTrace() : { ...emptyTrace(), packages: new Set([packageOfSpecifier(spec)]) };
  }
  const file = repoPath(ctx, decl.getSourceFile().fileName);
  if (file === undefined || !ctx.sourceFiles.has(file)) {
    const pkg = packageOfFile(decl.getSourceFile().fileName);
    return pkg === undefined || pkg === BUILTIN ? unknownTrace() : { ...emptyTrace(), packages: new Set([pkg]) };
  }
  if (ts.isParameter(decl)) return callbackTrace();
  if (key === undefined) {
    const fn = functionNodeOf(decl);
    if (fn && ctx.idOfNode.has(fn)) return traceFunctionExpression(ctx, fn);
  }
  if (ts.isBindingElement(decl)) return traceBinding(ctx, decl, key, depth);
  if (ts.isVariableDeclaration(decl)) {
    const sources = [...(decl.initializer ? [decl.initializer] : []), ...assignmentsTo(ctx, decl, symbol)];
    if (sources.length === 0) return unknownTrace();
    return sources.reduce((t, s) => merge(t, traceValue(ctx, s, key, depth + 1)), emptyTrace());
  }
  if (ts.isPropertyAssignment(decl)) return traceValue(ctx, decl.initializer, key, depth + 1);
  if (ts.isFunctionLike(decl) && key === undefined) return traceFunctionExpression(ctx, decl);
  return unknownTrace();
}

/** `const { a } = init` / `const [a] = init`: follow `init`'s property `a` (or element 0). */
function traceBinding(ctx: Context, element: ts.BindingElement, key: PropertyKey | undefined, depth: number): Trace {
  const pattern = element.parent;
  const holder = pattern.parent;
  if (ts.isParameter(holder)) return callbackTrace();
  if (!ts.isVariableDeclaration(holder) || !holder.initializer || element.dotDotDotToken || key !== undefined) return unknownTrace();
  if (ts.isArrayBindingPattern(pattern)) {
    return traceProperty(ctx, holder.initializer, String(pattern.elements.indexOf(element)), depth + 1);
  }
  const nameNode = element.propertyName ?? element.name;
  const name = ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) ? nameNode.text : undefined;
  return name === undefined ? unknownTrace() : traceProperty(ctx, holder.initializer, name, depth + 1);
}

/**
 * A call to a function from a package (`NextAuth({...})`, `useState()`): anything it returns, and
 * anything taken out of that, belongs to the package.
 */
function packageOfCall(ctx: Context, call: ts.CallExpression): Trace | undefined {
  const origin = originOfReceiver(ctx, call.expression);
  return typeof origin === "string" ? { ...emptyTrace(), packages: new Set([origin]) } : undefined;
}

/**
 * `await import("pkg")`: the module object of a package. `await import("./x")` with a property key:
 * that export of our module.
 */
function traceImport(ctx: Context, call: ts.CallExpression, key: PropertyKey | undefined, depth: number): Trace | undefined {
  if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const arg = call.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg)) return undefined;
  if (!isLocalSpecifier(ctx, arg.text)) {
    return isBuiltin(arg.text) ? undefined : { ...emptyTrace(), packages: new Set([packageOfSpecifier(arg.text)]) };
  }
  const moduleSymbol = ctx.checker.getSymbolAtLocation(arg);
  if (!moduleSymbol || typeof key !== "string") return undefined;
  const exported = ctx.checker.getExportsOfModule(moduleSymbol).find((s) => s.name === key);
  return exported ? traceSymbol(ctx, exported, undefined, depth + 1) : undefined;
}

/**
 * A package wrapper around one of our functions (`memo(PureInput)`, `forwardRef((p, ref) => …)`,
 * `debounce(save)`): calling or rendering the result runs our function.
 */
function wrappedFunction(ctx: Context, call: ts.CallExpression, depth: number): Trace | undefined {
  const first = call.arguments[0];
  if (!first || !ts.isIdentifier(call.expression)) return undefined;
  const value = unwrap(first);
  if (!ts.isIdentifier(value) && !ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return undefined;
  const trace = traceValue(ctx, value, undefined, depth + 1);
  return trace.ids.size > 0 && !trace.unknown ? { ...emptyTrace(), ids: trace.ids } : undefined;
}

const ELEMENT_METHODS = new Set(["find", "findLast", "at"]);

/** The elements of a const array literal, followed through `const list = [...]`. */
function arrayElements(ctx: Context, exprIn: ts.Expression, depth: number): ts.Expression[] | undefined {
  if (depth > MAX_TRACE_DEPTH) return undefined;
  const expr = unwrap(exprIn);
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.every((e) => !ts.isSpreadElement(e) && !ts.isOmittedExpression(e)) ? [...expr.elements] : undefined;
  }
  if (!ts.isIdentifier(expr)) return undefined;
  const decl = aliased(ctx.checker, ctx.checker.getSymbolAtLocation(expr))?.declarations?.[0];
  const isConst = decl && ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) && decl.parent.flags & ts.NodeFlags.Const;
  return isConst && decl.initializer ? arrayElements(ctx, decl.initializer, depth + 1) : undefined;
}

/** `list.find(…)`, `list.at(i)`: one of the list's elements, or its property `key` (D33). */
function traceElementOf(ctx: Context, call: ts.CallExpression, key: PropertyKey | undefined, depth: number): Trace | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ELEMENT_METHODS.has(callee.name.text)) return undefined;
  const elements = arrayElements(ctx, callee.expression, depth + 1);
  return elements?.reduce((t, e) => merge(t, traceValue(ctx, e, key, depth + 1)), emptyTrace());
}

function isClosure(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}

/**
 * Property `key` of what a local factory returns. A closure written right in the returned object runs
 * code from the factory (its calls are the factory's), plus the same-named function of the config object
 * passed in, which such wrappers call back (`createHandler({ onCreate })` → `.onCreate`) (D33).
 */
function traceFactoryProperty(ctx: Context, call: ts.CallExpression, fn: ts.SignatureDeclaration, key: PropertyKey, depth: number): Trace {
  const trace = emptyTrace();
  for (const returned of returnedExpressions(fn)) {
    const obj = unwrap(returned);
    const prop =
      key !== ALL_PROPERTIES && ts.isObjectLiteralExpression(obj)
        ? obj.properties.find((p) => p.name !== undefined && propertyKeyMatches(p.name, key))
        : undefined;
    const value = prop && ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : prop;
    if (!value || !isClosure(value) || ctx.idOfNode.has(value)) {
      merge(trace, traceProperty(ctx, returned, key, depth + 1));
      continue;
    }
    const factory = ctx.idOfNode.get(fn);
    if (factory !== undefined) trace.ids.add(factory);
    for (const arg of call.arguments) {
      const config = unwrap(arg);
      if (ts.isObjectLiteralExpression(config) && config.properties.some((p) => p.name !== undefined && propertyKeyMatches(p.name, key))) {
        merge(trace, traceProperty(ctx, config, key, depth + 1));
      }
    }
  }
  return trace.ids.size > 0 || trace.packages.size > 0 || trace.callback || trace.unknown ? trace : unknownTrace();
}

function propertyKeyMatches(name: ts.PropertyName, key: PropertyKey): boolean {
  if (key === ALL_PROPERTIES || ts.isComputedPropertyName(name)) return true;
  return (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) && name.text === key;
}

/** The functions `obj[key]` may hold; `ALL_PROPERTIES` for a computed key (a lookup table). */
function traceProperty(ctx: Context, objExpr: ts.Expression, key: PropertyKey, depth: number): Trace {
  if (depth > MAX_TRACE_DEPTH) return unknownTrace();
  const obj = unwrap(objExpr);
  if (ts.isObjectLiteralExpression(obj)) {
    const trace = emptyTrace();
    let matched = false;
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        merge(trace, traceProperty(ctx, prop.expression, key, depth + 1));
        matched = true;
        continue;
      }
      if (!prop.name || !propertyKeyMatches(prop.name, key)) continue;
      matched = true;
      if (ts.isPropertyAssignment(prop)) merge(trace, traceValue(ctx, prop.initializer, undefined, depth + 1));
      else if (ts.isShorthandPropertyAssignment(prop)) {
        merge(trace, traceSymbol(ctx, ctx.checker.getShorthandAssignmentValueSymbol(prop), undefined, depth + 1));
      } else merge(trace, traceFunctionExpression(ctx, prop));
    }
    return matched ? trace : unknownTrace();
  }
  if (ts.isArrayLiteralExpression(obj)) {
    const elements = key === ALL_PROPERTIES ? [...obj.elements] : [obj.elements[Number(key)]];
    if (elements.some((e) => e === undefined || ts.isSpreadElement(e) || ts.isOmittedExpression(e))) return unknownTrace();
    return elements.reduce((t, e) => (e ? merge(t, traceValue(ctx, e, undefined, depth + 1)) : t), emptyTrace());
  }
  if (ts.isIdentifier(obj)) return traceSymbol(ctx, ctx.checker.getSymbolAtLocation(obj), key, depth + 1);
  if (ts.isCallExpression(obj)) {
    const fn = localCallee(ctx, obj);
    if (!fn) return traceElementOf(ctx, obj, key, depth) ?? traceImport(ctx, obj, key, depth) ?? packageOfCall(ctx, obj) ?? unknownTrace();
    if (returnedExpressions(fn).length === 0) return unknownTrace();
    return traceFactoryProperty(ctx, obj, fn, key, depth);
  }
  return unknownTrace();
}

/** The functions an expression may evaluate to; with `key`, the functions in its property `key`. */
function traceValue(ctx: Context, exprIn: ts.Expression, key: PropertyKey | undefined, depth: number): Trace {
  if (depth > MAX_TRACE_DEPTH) return unknownTrace();
  if (key !== undefined) return traceProperty(ctx, exprIn, key, depth);
  const expr = unwrap(exprIn);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return traceFunctionExpression(ctx, expr);
  if (ts.isIdentifier(expr)) return traceSymbol(ctx, ctx.checker.getSymbolAtLocation(expr), undefined, depth + 1);
  if (ts.isPropertyAccessExpression(expr)) return traceProperty(ctx, expr.expression, expr.name.text, depth + 1);
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    const literal = ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg) ? arg.text : ALL_PROPERTIES;
    return traceProperty(ctx, expr.expression, literal, depth + 1);
  }
  if (ts.isCallExpression(expr)) {
    const fn = localCallee(ctx, expr);
    if (!fn) {
      return (
        traceElementOf(ctx, expr, undefined, depth) ??
        traceImport(ctx, expr, undefined, depth) ??
        wrappedFunction(ctx, expr, depth) ??
        packageOfCall(ctx, expr) ??
        unknownTrace()
      );
    }
    const returned = returnedExpressions(fn);
    if (returned.length === 0) return unknownTrace();
    return returned.reduce((t, r) => merge(t, traceValue(ctx, r, undefined, depth + 1)), emptyTrace());
  }
  if (ts.isConditionalExpression(expr)) {
    return merge(traceValue(ctx, expr.whenTrue, undefined, depth + 1), traceValue(ctx, expr.whenFalse, undefined, depth + 1));
  }
  if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
    return merge(traceValue(ctx, expr.left, undefined, depth + 1), traceValue(ctx, expr.right, undefined, depth + 1));
  }
  return unknownTrace();
}

/** Calls through a function value: one direct call per known target, else callback or dynamic. */
function resolveValueCall(ctx: Context, expr: ts.Expression): Resolution[] | undefined {
  const trace = traceValue(ctx, expr, undefined, 0);
  if (trace.unknown) return undefined;
  const ids = [...trace.ids].sort(compareStrings);
  const packages = [...trace.packages].sort(compareStrings);
  const oneOf = ids.length + packages.length + (trace.callback ? 1 : 0) > 1;
  const flag = oneOf ? { oneOf: true } : {};
  const resolved: Resolution[] = [
    ...ids.map((to): Resolution => ({ to, kind: "direct", ...flag })),
    ...packages.map((target): Resolution => ({ to: null, kind: "external", target, ...flag })),
  ];
  if (resolved.length > 0) return resolved;
  return trace.callback ? [{ to: null, kind: "callback" }] : undefined;
}

/** Our named functions handed to a call as values (`app.get("/", handler)`, `run({ a: fnA })`). */
function passedFunctions(ctx: Context, call: ts.CallExpression | ts.NewExpression): { to: string; callee: string }[] {
  const found: { to: string; callee: string }[] = [];
  const add = (expr: ts.Expression, symbol: ts.Symbol | undefined): void => {
    for (const decl of aliased(ctx.checker, symbol)?.declarations ?? []) {
      if (ts.isParameter(decl) || ts.isBindingElement(decl)) return;
      const fn = functionNodeOf(decl);
      const id = fn && ctx.idOfNode.get(fn);
      if (id !== undefined) {
        found.push({ to: id, callee: expr.getText().replace(/\s+/g, " ") });
        return;
      }
    }
  };
  const visitArg = (arg: ts.Expression): void => {
    const value = unwrap(arg);
    const inline = ctx.idOfNode.get(value);
    // A closure written right here but named (`cli.command("build").action(() => …)`): its calls are its own.
    if (inline !== undefined) found.push({ to: inline, callee: calleeText(call) });
    else if (ts.isIdentifier(value)) add(value, ctx.checker.getSymbolAtLocation(value));
    else if (ts.isPropertyAccessExpression(value)) add(value, ctx.checker.getSymbolAtLocation(value.name));
    else if (ts.isObjectLiteralExpression(value)) {
      for (const prop of value.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const init = unwrap(prop.initializer);
          if (ts.isIdentifier(init)) add(init, ctx.checker.getSymbolAtLocation(init));
          else if (ts.isPropertyAccessExpression(init)) add(init, ctx.checker.getSymbolAtLocation(init.name));
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          add(prop.name, ctx.checker.getShorthandAssignmentValueSymbol(prop));
        }
      }
    }
  };
  for (const arg of call.arguments ?? []) visitArg(arg);
  return found;
}
function resolveCall(ctx: Context, call: ts.CallExpression | ts.NewExpression): Resolution[] {
  const expr = call.expression;
  if (expr.kind === ts.SyntaxKind.SuperKeyword || expr.kind === ts.SyntaxKind.ImportKeyword) return [];
  const nameNode = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isIdentifier(expr) ? expr : undefined;
  if (nameNode === undefined) return resolveValueCall(ctx, expr) ?? [{ to: null, kind: "dynamic" }];
  const single = resolveNamedCall(ctx, expr, nameNode);
  return Array.isArray(single) ? single : single ? [single] : [];
}

function resolveNamedCall(ctx: Context, expr: ts.Expression, nameNode: ts.Identifier | ts.MemberName): Resolution | Resolution[] | undefined {

  const symbol = aliased(ctx.checker, ctx.checker.getSymbolAtLocation(nameNode));
  for (const decl of symbol?.declarations ?? []) {
    const fnNode = functionNodeOf(decl);
    const id = fnNode && ctx.idOfNode.get(fnNode);
    if (id !== undefined) return { to: id, kind: "direct" };
  }
  const decl = symbol?.declarations?.[0];
  if (decl) {
    const file = repoPath(ctx, decl.getSourceFile().fileName);
    if (file === undefined || !ctx.sourceFiles.has(file)) {
      const pkg = packageOfFile(decl.getSourceFile().fileName);
      return pkg === BUILTIN || pkg === undefined ? undefined : { to: null, kind: "external", target: pkg };
    }
  }
  const byType = resolveByType(ctx, expr);
  if (byType !== "unknown") return byType;
  const traced = resolveValueCall(ctx, expr);
  if (traced) return traced;
  const origin = originOfReceiver(ctx, expr);
  if (origin === BUILTIN) return undefined;
  if (origin !== undefined) return { to: null, kind: "external", target: origin };
  // A function held in a variable we couldn't follow: which one runs is decided at runtime.
  if (ts.isIdentifier(expr)) return { to: null, kind: "dynamic" };
  // A member call whose receiver type couldn't be resolved (usually a library or built-in type
  // without installed typings, e.g. `buf.subarray()`): not recorded, like built-ins (D20).
  return undefined;
}

type Flags = Pick<CallFact, "conditional" | "parallel" | "onError" | "passed" | "tool">;

/** Our functions an expression stands for (a handler, a component tag), traced like a called value. */
function functionsOf(ctx: Context, expr: ts.Expression): string[] {
  const direct = ctx.idOfNode.get(unwrap(expr));
  if (direct !== undefined) return [direct];
  const trace = traceValue(ctx, expr, undefined, 0);
  return trace.unknown ? [] : [...trace.ids].sort(compareStrings);
}

/** Text of a string or template literal, with `${…}` parts as PLACEHOLDER. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => PLACEHOLDER + s.literal.text).join("");
  return undefined;
}

const STRING_TESTS = new Set(["startsWith", "endsWith", "includes", "match", "test", "replace", "split", "indexOf"]);
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** A URL that's compared or matched (`pathname.startsWith("/api")`), or a route being defined (`app.post("/x", fn)`), is not a request. */
function isUrlTest(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.arguments.length > 1 && registrationOf(parent.arguments[parent.arguments.length - 1]!)) return true;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return true;
  if (ts.isCaseClause(parent)) return true;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) return STRING_TESTS.has(parent.expression.name.text);
  return false;
}

/** `fetch(url, { method: "POST" })` → POST; a bare `fetch(url)` → GET; otherwise unknown. */
function methodOf(node: ts.Node): string | undefined {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== node) return undefined;
  const options = call.arguments[1] && unwrap(call.arguments[1]);
  if (options && ts.isObjectLiteralExpression(options)) {
    const prop = options.properties.find((p) => p.name !== undefined && propertyName(p.name) === "method");
    if (prop && ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) return prop.initializer.text.toUpperCase();
  }
  return ts.isIdentifier(call.expression) && call.expression.text === "fetch" && call.arguments.length === 1 ? "GET" : undefined;
}

/** Client → server links: a written URL matching our routes becomes a call into the route's handler. */
function remoteCalls(ctx: Context, file: string, node: ts.Node): { to: string; callee: string; remote: string; oneOf?: true }[] {
  if (ctx.routes.length === 0 || ctx.serverFiles.has(file) || isUrlTest(node)) return [];
  const text = literalText(node);
  if (text === undefined || !text.includes("/")) return [];
  const hits = matchRoutes(text, methodOf(node), ctx.routes);
  return hits.map((r) => ({ to: r.handler, callee: `${r.method} ${r.url}`, remote: r.entry, ...(hits.length > 1 ? { oneOf: true as const } : {}) }));
}

/** The outermost call into a package that `node` is an argument of, within its function. */
function configuringPackage(ctx: Context, node: ts.Node): string | undefined {
  let found: string | undefined;
  for (let at = node.parent; at && !ts.isSourceFile(at) && !ts.isFunctionLike(at); at = at.parent) {
    if (!ts.isCallExpression(at) && !ts.isNewExpression(at)) continue;
    if (!at.arguments?.some((arg) => arg.pos <= node.pos && node.end <= arg.end)) continue;
    const origin = originOfReceiver(ctx, at.expression);
    if (typeof origin === "string") found = origin;
  }
  return found;
}

/** Our routes written in `node`'s arguments (not inside closures there), as a package would request them. */
function routesWrittenIn(ctx: Context, call: ts.CallExpression | ts.NewExpression): Route[] {
  const found: Route[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    const text = literalText(node);
    if (text !== undefined && text.includes("/") && !isUrlTest(node)) {
      for (const hit of matchRoutes(text, methodOf(node), ctx.routes)) if (!found.includes(hit)) found.push(hit);
    }
    ts.forEachChild(node, visit);
  };
  for (const arg of call.arguments ?? []) visit(arg);
  return found;
}

/** Routes written into package calls, by package (D42). */
function configuredRoutes(ctx: Context, sourceFiles: ts.SourceFile[]): Map<string, Route[]> {
  const byPackage = new Map<string, Route[]>();
  for (const sf of sourceFiles) {
    if (ctx.serverFiles.has(repoPath(ctx, sf.fileName) ?? "")) continue;
    const visit = (node: ts.Node): void => {
      const text = literalText(node);
      if (text !== undefined && text.includes("/") && !isUrlTest(node)) {
        const hits = matchRoutes(text, methodOf(node), ctx.routes);
        const pkg = hits.length > 0 ? configuringPackage(ctx, node) : undefined;
        if (pkg !== undefined) {
          const routes = byPackage.get(pkg) ?? [];
          for (const hit of hits) if (!routes.includes(hit)) routes.push(hit);
          byPackage.set(pkg, routes);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return byPackage;
}

/** Function names that send a request when a configured package hands them out (`sendMessage`, `mutate`). */
const REQUEST_NAME = /^(send|submit|regenerate|reload|resume|retry|refetch|refresh|revalidate|mutate|trigger|fetch|load|append|complete|upload)/i;
/** The request-named functions that send new data. */
const POST_NAME = /^(send|submit|append|complete|upload)/i;

function isImportBinding(decl: ts.Declaration): boolean {
  return ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl) || ts.isImportEqualsDeclaration(decl);
}

/**
 * Routes a local value from a package may request. `const { send } = useChat({ api: "/api/chat" })`: the
 * routes written in that call. A parameter typed `Helpers["send"]` (or a destructured prop declared so):
 * every route written into calls to that package.
 */
function valueRoutes(ctx: Context, ident: ts.Identifier): Route[] {
  const decl = ctx.checker.getSymbolAtLocation(ident)?.declarations?.[0];
  if (!decl || isImportBinding(decl)) return [];
  let typeNode: ts.TypeNode | undefined;
  let init: ts.Expression | undefined;
  if (ts.isParameter(decl) || ts.isVariableDeclaration(decl)) {
    typeNode = decl.type;
    init = ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
  } else if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
    const holder = decl.parent.parent;
    const nameNode = decl.propertyName ?? decl.name;
    const name = ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) ? nameNode.text : undefined;
    if (ts.isParameter(holder) && holder.type && name !== undefined) {
      const prop = ctx.checker.getTypeFromTypeNode(holder.type).getProperty(name)?.declarations?.[0];
      if (prop && (ts.isPropertySignature(prop) || ts.isPropertyDeclaration(prop))) typeNode = prop.type;
    } else if (ts.isVariableDeclaration(holder)) init = holder.initializer;
  }
  const typed = typeRootIdentifier(typeNode);
  if (typed) {
    const origin = originOf(ctx, typed);
    return typeof origin === "string" ? (ctx.configured.get(origin) ?? []) : [];
  }
  const call = init && unwrap(init);
  if (!call || (!ts.isCallExpression(call) && !ts.isNewExpression(call))) return [];
  return typeof originOfReceiver(ctx, call.expression) === "string" ? routesWrittenIn(ctx, call) : [];
}

/**
 * A request a package sends for us later (D42): calling `sendMessage` handed out by a package that was
 * given one of our routes (`useChat({ transport: … "/api/chat" })`) runs that route.
 */
function configuredCalls(ctx: Context, file: string, call: ts.CallExpression): { to: string; callee: string; remote: string; oneOf?: true }[] {
  if (ctx.configured.size === 0 || ctx.serverFiles.has(file)) return [];
  const expr = call.expression;
  const name = ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isIdentifier(expr) ? expr.text : undefined;
  const root = rootIdentifier(expr);
  if (name === undefined || !root || !REQUEST_NAME.test(name)) return [];
  const all = valueRoutes(ctx, root);
  // A package's send function posts; the other methods written at the same URL belong to other calls.
  const posts = POST_NAME.test(name) ? all.filter((r) => r.method === "POST") : [];
  const routes = posts.length > 0 ? posts : all;
  return routes.map((r) => ({ to: r.handler, callee: `${r.method} ${r.url}`, remote: r.entry, ...(routes.length > 1 ? { oneOf: true as const } : {}) }));
}

const AI_SYSTEM = "ai-model";

/** The `tools: { … }` object of a call into an AI SDK package, if `obj` is one (D33). */
function isToolsObject(ctx: Context, obj: ts.Node): obj is ts.ObjectLiteralExpression {
  if (!ts.isObjectLiteralExpression(obj)) return false;
  const prop = obj.parent;
  if (!ts.isPropertyAssignment(prop) || propertyName(prop.name) !== "tools" || prop.initializer !== obj) return false;
  const options = prop.parent;
  const call = options.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(options as ts.Expression)) return false;
  const origin = originOfReceiver(ctx, call.expression);
  return typeof origin === "string" && externalFor(origin)?.id === AI_SYSTEM;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** `weather` in `tools: { weather }` where `const weather = tool({ execute })`: the named `execute` function. */
function toolExecute(ctx: Context, symbol: ts.Symbol | undefined): string | undefined {
  const decl = aliased(ctx.checker, symbol)?.declarations?.[0];
  const init = decl && ts.isVariableDeclaration(decl) && decl.initializer ? unwrap(decl.initializer) : undefined;
  if (!init || !ts.isCallExpression(init)) return undefined;
  for (const arg of init.arguments) {
    const config = unwrap(arg);
    if (!ts.isObjectLiteralExpression(config)) continue;
    const prop = config.properties.find((p) => p.name !== undefined && propertyName(p.name) === "execute");
    const fn = prop && ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : prop;
    const id = fn && ctx.idOfNode.get(fn);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Tools given as values (`tools: { weather }`): recorded as passed calls to their `execute`. */
function passedTools(ctx: Context, call: ts.CallExpression | ts.NewExpression): { to: string; callee: string }[] {
  const found: { to: string; callee: string }[] = [];
  for (const arg of call.arguments ?? []) {
    const options = unwrap(arg);
    if (!ts.isObjectLiteralExpression(options)) continue;
    for (const prop of options.properties) {
      if (!ts.isPropertyAssignment(prop) || !isToolsObject(ctx, prop.initializer)) continue;
      for (const tool of prop.initializer.properties) {
        const value = ts.isShorthandPropertyAssignment(tool) ? tool.name : ts.isPropertyAssignment(tool) ? unwrap(tool.initializer) : undefined;
        if (!value || !ts.isIdentifier(value)) continue;
        const symbol = ts.isShorthandPropertyAssignment(tool) ? ctx.checker.getShorthandAssignmentValueSymbol(tool) : ctx.checker.getSymbolAtLocation(value);
        const to = toolExecute(ctx, symbol);
        if (to !== undefined) found.push({ to, callee: `${value.text}.execute` });
      }
    }
  }
  return found;
}

function flagsOf(ctx: Context, call: ts.Node, unit: ts.Node): Flags {
  const flags: Flags = {};
  if (ts.isOptionalChain(call)) flags.conditional = true;
  let child: ts.Node = call;
  let node: ts.Node | undefined = call.parent;
  while (node && node !== unit) {
    if (ts.isPropertyAssignment(node) && child === node.initializer && isToolsObject(ctx, node.parent)) {
      flags.conditional = true;
      flags.tool = true;
    } else if (ts.isIfStatement(node) && child !== node.expression) flags.conditional = true;
    else if (ts.isConditionalExpression(node) && child !== node.condition) flags.conditional = true;
    else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) flags.conditional = true;
    else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isPropertyAssignment(node.parent) &&
      ts.isObjectLiteralExpression(node.parent.parent)
    ) {
      // A closure in an object (`runQuery({ pg: () => a(), ch: () => b() })`) runs only if the receiver picks it.
      flags.conditional = true;
    }
    else if (ts.isCatchClause(node)) {
      flags.conditional = true;
      flags.onError = true;
    } else if (ts.isBinaryExpression(node) && child === node.right) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        flags.conditional = true;
      }
    } else if (
      ts.isCallExpression(node) &&
      PROMISE_COMBINATOR.test(node.expression.getText()) &&
      node.arguments.some((arg) => arg === child || (arg.pos <= child.pos && child.end <= arg.end))
    ) {
      flags.parallel = true;
    }
    child = node;
    node = node.parent;
  }
  return flags;
}

function calleeText(call: ts.CallExpression | ts.NewExpression): string {
  const text = (ts.isNewExpression(call) ? "new " : "") + call.expression.getText().replace(/\s+/g, " ");
  return text.length > MAX_CALLEE_LENGTH ? `${text.slice(0, MAX_CALLEE_LENGTH - 1)}…` : text;
}

function callsInUnit(ctx: Context, id: string, unit: FunctionNode | ts.SourceFile): CallFact[] {
  const sourceFile = unit.getSourceFile();
  const file = id.slice(0, id.indexOf("#"));
  const calls: CallFact[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node: ts.Node): void => {
    if (node !== unit && ctx.idOfNode.has(node)) {
      // A named closure written in a JSX event prop runs when the event fires.
      const ev = jsxEventOf(node);
      if (ev) calls.push({ from: id, to: ctx.idOfNode.get(node)!, kind: "direct", line: lineOf(node), callee: `<${ev.tag} ${ev.event}>`, ...flagsOf(ctx, node, unit), conditional: true, passed: true, event: ev.event });
      return; // nested named function: its calls are its own
    }
    if (ts.isJsxExpression(node) && node.expression && !ctx.idOfNode.has(unwrap(node.expression))) {
      const ev = jsxEventOf(node.expression);
      if (ev) {
        for (const to of functionsOf(ctx, node.expression)) {
          calls.push({ from: id, to, kind: "direct", line: lineOf(node), callee: `<${ev.tag} ${ev.event}>`, ...flagsOf(ctx, node, unit), conditional: true, passed: true, event: ev.event });
        }
      }
    }
    // Post-order = evaluation order: in `f(g())` and `a().b()`, the inner call runs first.
    ts.forEachChild(node, visit);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const isComponent = ts.isPropertyAccessExpression(tag) || (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text));
      if (isComponent) {
        for (const to of functionsOf(ctx, tag as ts.Expression)) {
          calls.push({ from: id, to, kind: "direct", line: lineOf(node), callee: `<${jsxTagName(node)}>`, ...flagsOf(ctx, node, unit), render: true });
        }
      }
    }
    for (const link of remoteCalls(ctx, file, node)) {
      const flags = flagsOf(ctx, node, unit);
      calls.push({ from: id, kind: "direct", line: lineOf(node), ...link, ...flags, ...(link.oneOf ? { conditional: true } : {}) });
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const flags = flagsOf(ctx, node, unit);
      for (const link of ts.isCallExpression(node) ? configuredCalls(ctx, file, node) : []) {
        calls.push({ from: id, kind: "direct", line, ...link, ...flags, ...(link.oneOf ? { conditional: true } : {}) });
      }
      // A passed function runs only if and when the receiver calls it.
      for (const passed of passedFunctions(ctx, node)) {
        calls.push({ from: id, to: passed.to, kind: "direct", line, callee: passed.callee, ...flags, conditional: true, passed: true });
      }
      for (const passed of passedTools(ctx, node)) {
        calls.push({ from: id, to: passed.to, kind: "direct", line, callee: passed.callee, ...flags, conditional: true, passed: true, tool: true });
      }
      for (const resolution of resolveCall(ctx, node)) {
        calls.push({
          from: id,
          ...resolution,
          line,
          callee: calleeText(node),
          ...flags,
          ...(resolution.oneOf ? { conditional: true } : {}),
        });
      }
    }
  };
  if (ts.isSourceFile(unit)) unit.statements.forEach(visit);
  else if (unit.body) visit(unit.body); // a concise arrow's body is itself the call expression
  return calls;
}

function systemPackagesByFile(imports: ImportFact[]): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const { from, to } of imports) {
    if (!to.startsWith(PKG_PREFIX)) continue;
    const pkg = to.slice(PKG_PREFIX.length);
    if (externalFor(pkg) === undefined) continue;
    byFile.set(from, [...(byFile.get(from) ?? []), pkg].sort(compareStrings));
  }
  return byFile;
}

const SEND_NAME = /^(write|send|emit|enqueue|publish|postMessage|dispatch|broadcast)/i;

/** The named function (or module unit) whose calls include `node`'s. */
function enclosingId(ctx: Context, node: ts.Node): string | undefined {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    const id = ctx.idOfNode.get(at);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** `"data-x"` in `stream.write({ type: "data-x", … })`: a message sent. */
function sentType(node: ts.Node): string | undefined {
  if (!ts.isPropertyAssignment(node) || propertyName(node.name) !== "type" || !ts.isStringLiteralLike(node.initializer)) return undefined;
  const call = node.parent.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node.parent as ts.Expression)) return undefined;
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
  return SEND_NAME.test(name) ? node.initializer.text : undefined;
}

/** `"data-x"` in `part.type === "data-x"` or `switch (part.type) { case "data-x": … }`: a message handled. */
function handledType(node: ts.Node): string | undefined {
  const isTypeRead = (e: ts.Expression): boolean => ts.isPropertyAccessExpression(e) && e.name.text === "type";
  if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
    if (ts.isStringLiteralLike(node.right) && isTypeRead(node.left)) return node.right.text;
    if (ts.isStringLiteralLike(node.left) && isTypeRead(node.right)) return node.left.text;
  }
  if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression) && isTypeRead(node.parent.parent.expression)) return node.expression.text;
  return undefined;
}

/**
 * Server → client messages (D42): a server function that sends `{ type: "data-x" }` links to each client
 * function that checks for `type === "data-x"`. The journey continues in the browser.
 */
function messageLinks(ctx: Context, sourceFiles: ts.SourceFile[], sides: Map<string, Side>): CallFact[] {
  const sent = new Map<string, { from: string; line: number }[]>();
  const handled = new Map<string, Set<string>>();
  for (const sf of sourceFiles) {
    const side = sides.get(repoPath(ctx, sf.fileName) ?? "");
    if (side === undefined) continue;
    const visit = (node: ts.Node): void => {
      const out = side === "server" ? sentType(node) : undefined;
      const into = side !== "server" ? handledType(node) : undefined;
      const id = out !== undefined || into !== undefined ? enclosingId(ctx, node) : undefined;
      if (id !== undefined && out !== undefined) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        sent.set(out, [...(sent.get(out) ?? []), { from: id, line }]);
      }
      if (id !== undefined && into !== undefined) handled.set(into, (handled.get(into) ?? new Set()).add(id));
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const links: CallFact[] = [];
  for (const [type, writers] of sent) {
    const readers = [...(handled.get(type) ?? [])].sort(compareStrings);
    for (const w of writers) {
      for (const to of readers) links.push({ from: w.from, to, kind: "direct", line: w.line, callee: `message "${type}"`, conditional: true, message: type });
    }
  }
  return links;
}

export type FunctionIndex = { units: { id: string; node: FunctionNode | ts.SourceFile }[]; idOfNode: Map<ts.Node, string> };

/** Every named function's AST node in the program; `moduleFiles` also get their top-level unit. */
export function indexFunctions(program: ts.Program, repoRoot: string, sourceFiles: string[], moduleFiles: Set<string> = new Set()): FunctionIndex {
  // Creating the checker binds every file, which sets the parent pointers collectFunctions relies on.
  program.getTypeChecker();
  const units: FunctionIndex["units"] = [];
  const idOfNode = new Map<ts.Node, string>();
  for (const path of sourceFiles) {
    const sourceFile = program.getSourceFile(`${repoRoot}/${path}`);
    if (!sourceFile) continue;
    for (const { fact, node } of collectFunctions(path, sourceFile, moduleFiles.has(path))) {
      units.push({ id: fact.id, node });
      idOfNode.set(node, fact.id);
    }
  }
  return { units, idOfNode };
}

/** Every call made inside every named function, resolved with the type checker (D20). */
export function extractCalls(
  program: ts.Program,
  repoRoot: string,
  sourceFiles: string[],
  imports: ImportFact[],
  index: FunctionIndex = indexFunctions(program, repoRoot, sourceFiles),
  routes: Route[] = [],
  sides: Map<string, Side> = new Map(),
): CallFact[] {
  const serverFiles = new Set([...sides].flatMap(([file, side]) => (side === "server" ? [file] : [])));
  const checker = program.getTypeChecker();
  const { units, idOfNode } = index;
  const options = program.getCompilerOptions();
  const ctx: Context = {
    checker,
    repoRoot,
    sourceFiles: new Set(sourceFiles),
    idOfNode,
    localPrefixes: Object.keys(options.paths ?? {})
      .map((key) => key.replace(/\*$/, ""))
      .filter((p) => p.length > 0),
    systemPackagesOf: systemPackagesByFile(imports),
    traceCache: new Map(),
    routes,
    serverFiles,
    configured: new Map(),
  };
  const files = sourceFiles.flatMap((path) => program.getSourceFile(`${repoRoot}/${path}`) ?? []);
  if (routes.length > 0) ctx.configured = configuredRoutes(ctx, files);
  const calls = [...units.flatMap(({ id, node }) => callsInUnit(ctx, id, node)), ...messageLinks(ctx, files, sides)];
  // Stable sort: calls stay in evaluation order within each function.
  return calls.sort((a, b) => compareStrings(a.from, b.from));
}
