import type { User } from "./types";
import { pool } from "./client";

export async function findUser(name: string): Promise<User | undefined> {
  const result = await pool.query("select * from users where name = $1", [name]);
  return result.rows[0];
}

export const repo = {
  save(user: User) {
    return pool.query("insert into users values ($1)", [user.id]);
  },
  remove: (id: string) => pool.query("delete from users where id = $1", [id]),
};
