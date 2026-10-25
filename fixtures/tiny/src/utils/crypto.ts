import { createHash } from "node:crypto";

export function hashPassword(password: string): string {
  function inner(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
  return inner(password);
}
