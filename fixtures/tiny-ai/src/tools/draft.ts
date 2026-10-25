import { tool } from "ai";
import { handlers } from "@/artifacts/registry";

export const draft = ({ user }: { user: string }) =>
  tool({
    execute: async ({ kind, title }: { kind: string; title: string }) => {
      const handler = handlers.find((h) => h.kind === kind);
      if (!handler) throw new Error("no handler");
      await handler.onCreate({ title, user });
      return { title };
    },
  });
