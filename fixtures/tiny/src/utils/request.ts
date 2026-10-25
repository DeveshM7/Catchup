// Mirrors a common pattern: a helper whose loose return type hides the functions it returns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseInput(request: Request): Promise<any> {
  let error: (() => Response) | undefined;
  if (!request.url) error = () => reject("no url");
  return { body: await request.text(), error };
}

function reject(reason: string): Response {
  return new Response(reason, { status: 400 });
}

export function runEither(queries: Record<string, () => string>, key: string): string {
  return queries[key]();
}
