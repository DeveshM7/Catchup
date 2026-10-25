import type { User } from "@/db/types";
import { findUser } from "@/db/users";

export const listUsers = async (): Promise<User[]> => {
  const user = await findUser("1");
  return user ? [user] : [];
};
