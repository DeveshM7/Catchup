import { clearChats, listChats } from "../../../lib/db";

export async function GET() {
  return Response.json(await listChats());
}

export async function DELETE() {
  await clearChats();
  return new Response(null, { status: 204 });
}
