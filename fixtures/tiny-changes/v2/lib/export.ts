import { listChats } from "./db";

export async function exportChats(): Promise<string> {
  const chats = await listChats();
  return JSON.stringify(chats);
}
