import { exportChats } from "../../../lib/export";

export async function GET() {
  return new Response(await exportChats(), { headers: { "content-type": "application/json" } });
}
