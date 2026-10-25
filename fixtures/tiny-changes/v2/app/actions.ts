"use server";

import { renameChat } from "../lib/db";

export async function rename(title: string) {
  await renameChat(title);
}
