import { pool } from "@/db/client";

export function createSession(userId: string) {
  return pool.query("insert into sessions (user_id) values ($1)", [userId]);
}
