import { findUser } from "@/db/users";
import { hashPassword } from "../utils/crypto";
import { createSession } from "./session";

export async function login(name: string, password: string) {
  const user = await findUser(name);
  if (!user || user.passwordHash !== hashPassword(password)) {
    return null;
  }
  return createSession(user.id);
}

export class Session {
  start(): string {
    return "started";
  }
}
