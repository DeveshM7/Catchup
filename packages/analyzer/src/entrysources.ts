import { join } from "node:path";
import ts from "typescript";
import type { EntryPointFact } from "./facts.js";
import { functionNodeOf, type FunctionIndex } from "./calls.js";
import { MODULE_UNIT, isRenderRoot, registrationOf } from "./functions.js";
import type { PackageInfo } from "./packages.js";

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const NEXT_PAGE = /(^|\/)app\/(.*\/)?(page|layout)\.(ts|tsx|js|jsx)$/;
const PAGES_PAGE = /(^|\/)pages\/(.*)\.(tsx|jsx|ts|js)$/;

/** Next.js app-router page or layout → URL (route groups and slots vanish, like `appRouteUrl`). */
export function appPageUrl(file: string): { url: string; layout: boolean } | undefined {
  const match = NEXT_PAGE.exec(file);
  if (!match) return undefined;
  const segments = (match[2] ?? "").split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s.startsWith("_"))) return undefined;
  const visible = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  return { url: `/${visible.join("/")}`, layout: match[3] === "layout" };
}

/** Next.js pages-router page (not an API route, not `_app`/`_document`) → URL. */
export function pagesPageUrl(file: string): string | undefined {
  const match = PAGES_PAGE.exec(file);
  const path = match?.[2];
  if (!path || path === "api" || path.startsWith("api/") || path.split("/").some((s) => s.startsWith("_"))) return undefined;
  return `/${path}`.replace(/\/index$/, "") || "/";
}

export function directiveOf(sourceFile: ts.SourceFile): "use client" | "use server" | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return undefined;
    const text = statement.expression.text;
    if (text === "use client" || text === "use server") return text;
  }
  return undefined;
}

type Ctx = { checker: ts.TypeChecker; index: FunctionIndex };

function functionIdOf(ctx: Ctx, expr: ts.Expression): string | undefined {
  const direct = ctx.index.idOfNode.get(expr);
  if (direct !== undefined) return direct;
  const nameNode = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isIdentifier(expr) ? expr : undefined;
  let symbol = nameNode && ctx.checker.getSymbolAtLocation(nameNode);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  for (const decl of symbol?.declarations ?? []) {
    const node = functionNodeOf(decl);
    const id = node && ctx.index.idOfNode.get(node);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Export name → function id for a module's exports (following re-exports). */
function exportedFunctions(ctx: Ctx, sourceFile: ts.SourceFile): Map<string, string> {
  const found = new Map<string, string>();
  const moduleSymbol = ctx.checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return found;
  for (const exported of ctx.checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(exported) : exported;
    for (const decl of symbol.declarations ?? []) {
      const node = functionNodeOf(decl);
      const id = node && ctx.index.idOfNode.get(node);
      if (id !== undefined) {
        found.set(exported.name, id);
        break;
      }
    }
  }
  return found;
}

/** Every function some module of ours exports. */
export function exportedFunctionIds(program: ts.Program, repoRoot: string, files: string[], index: FunctionIndex): Set<string> {
  const ctx: Ctx = { checker: program.getTypeChecker(), index };
  const ids = new Set<string>();
  for (const file of files) {
    const sf = program.getSourceFile(join(repoRoot, file));
    if (sf) for (const id of exportedFunctions(ctx, sf).values()) ids.add(id);
  }
  return ids;
}

function entry(kind: EntryPointFact["kind"], label: string, handler: string, id = `${kind}:${label}`): EntryPointFact {
  return { id, kind, label, handler, file: handler.slice(0, handler.indexOf("#")) };
}

/** `app.post("/x", handler)` (Express-style) and `cli.command("build").action(fn)` registrations. */
function registrations(ctx: Ctx, sourceFile: ts.SourceFile): EntryPointFact[] {
  const found: EntryPointFact[] = [];
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const last = node.arguments[node.arguments.length - 1]!;
    const reg = registrationOf(last);
    if (!reg) return;
    const handler = functionIdOf(ctx, last);
    if (handler === undefined) return;
    if (HTTP_VERBS.has(reg.method) && reg.key.startsWith("/")) {
      found.push(entry("http", `${reg.method === "all" ? "ANY" : reg.method.toUpperCase()} ${reg.key}`, handler));
    } else if (reg.method === "command") {
      found.push(entry("cli", `command ${reg.key}`, handler));
    }
  };
  visit(sourceFile);
  return found;
}

export type EntrySourceInputs = {
  program: ts.Program;
  repoRoot: string;
  files: string[];
  index: FunctionIndex;
  packages: PackageInfo[];
};

/**
 * Entry points beyond Next.js API routes (Build 1): pages and layouts, server actions, CLI bins and commands,
 * a library's exports, Express-style routes, and app roots that render a UI.
 */
export function findEntrySources(inputs: EntrySourceInputs): EntryPointFact[] {
  const ctx: Ctx = { checker: inputs.program.getTypeChecker(), index: inputs.index };
  const sourceOf = (file: string): ts.SourceFile | undefined => inputs.program.getSourceFile(join(inputs.repoRoot, file));
  const found: EntryPointFact[] = [];

  for (const file of inputs.files) {
    const sf = sourceOf(file);
    if (!sf) continue;
    const page = appPageUrl(file);
    const pagesUrl = page ? undefined : pagesPageUrl(file);
    if (page || pagesUrl !== undefined) {
      const handler = exportedFunctions(ctx, sf).get("default");
      if (handler) found.push(entry("page", page ? `${page.layout ? "layout" : "page"} ${page.url}` : `page ${pagesUrl}`, handler));
    }
    if (directiveOf(sf) === "use server") {
      for (const [name, handler] of exportedFunctions(ctx, sf)) found.push(entry("action", `action ${name}`, handler, `action:${handler}`));
    }
    if (isRenderRoot(sf)) found.push(entry("page", `app root ${file}`, `${file}#${MODULE_UNIT}`));
    found.push(...registrations(ctx, sf));
  }

  for (const pkg of inputs.packages) {
    for (const bin of pkg.bins) found.push(entry("cli", `$ ${bin.name}`, `${bin.file}#${MODULE_UNIT}`));
    if (pkg.private) continue;
    for (const { subpath, file } of pkg.entries) {
      const sf = sourceOf(file);
      if (!sf) continue;
      const prefix = subpath === "." ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, "")}`;
      for (const [name, handler] of exportedFunctions(ctx, sf)) found.push(entry("library", `${prefix}: ${name}()`, handler));
    }
  }

  // Same label twice (three layouts at "/", one command name in two files): the file tells them apart.
  const seen = new Set<string>();
  return found.flatMap((e) => {
    const twice = seen.has(e.id);
    const id = twice ? `${e.id} @${e.file}` : e.id;
    if (seen.has(id)) return [];
    seen.add(id);
    return [twice ? { ...e, id, label: `${e.label} @${e.file}` } : e];
  });
}
