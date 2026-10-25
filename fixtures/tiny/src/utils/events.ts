import { pool } from "@/db/client";

export async function audit(name: string) {
  await pool.query("insert into audit (name) values ($1)", [name]);
  return name;
}

export function notify(name: string): string {
  return name.toUpperCase();
}
