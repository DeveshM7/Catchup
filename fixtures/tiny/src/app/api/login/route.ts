import { login } from "@/auth/login";
import { audit, notify } from "@/utils/events";
import { log } from "@/utils/log";
import { parseInput, runEither } from "@/utils/request";

const handlers: Record<string, () => string> = { a: () => "a", b: () => "b" };
const registry = new Map<string, () => void>();

export async function POST(request: Request) {
  const body = await request.json();
  if (!isValidBody(body)) {
    return new Response("bad", { status: 400 });
  }
  try {
    const session = await login(body.name, body.password);
    await Promise.all([audit(body.name), notify(body.name)]);
    handlers[body.kind]?.();
    return Response.json({ session });
  } catch (error) {
    log(error);
    return new Response("error", { status: 500 });
  }
}

export async function GET(request: Request) {
  const { error } = await parseInput(request);
  if (error) return error();
  registry.get(request.method)?.();
  return Response.json({ result: runEither({ fast: () => quick(), slow: full }, request.url) });
}

function quick(): string {
  return "quick";
}

function full(): string {
  return "full";
}

function isValidBody(body: unknown): boolean {
  return typeof body === "object" && body !== null;
}
