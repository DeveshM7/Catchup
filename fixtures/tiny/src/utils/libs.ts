import NextAuth from "next-auth";
import { useState } from "react";
import { drizzle } from "drizzle-orm/postgres-js";

export const { auth, signIn } = NextAuth({});
const db = drizzle("postgres://localhost");

export async function whoAmI() {
  const session = await auth();
  return db.select().from(session);
}

export function useCounter() {
  const [count, setCount] = useState(0);
  setCount(count + 1);
}
