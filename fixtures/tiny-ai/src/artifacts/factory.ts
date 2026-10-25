import { pool } from "@/db/client";

export type Handler = { kind: string; onCreate: (args: { title: string; user: string }) => Promise<void> };

export function createHandler(config: { kind: string; onCreate: (args: { title: string }) => Promise<string> }): Handler {
  return {
    kind: config.kind,
    onCreate: async (args) => {
      const content = await config.onCreate({ title: args.title });
      await pool.query("insert into docs values ($1, $2)", [args.title, content]);
    },
  };
}
