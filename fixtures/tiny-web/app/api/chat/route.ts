import { createUIMessageStream } from "ai";
import { deleteChat, saveChat } from "../../../lib/db";

export async function POST() {
  await saveChat();
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "data-title", data: "New chat" });
    },
  });
  return new Response(stream);
}

export async function DELETE() {
  await deleteChat();
  return new Response(null, { status: 204 });
}
