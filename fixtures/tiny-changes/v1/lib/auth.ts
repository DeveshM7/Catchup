export function requireUser(request: Request): string {
  const user = request.headers.get("x-user");
  if (!user) throw new Response("Unauthorized", { status: 401 });
  return user;
}
