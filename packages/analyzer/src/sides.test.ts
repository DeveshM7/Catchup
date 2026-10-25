import { describe, expect, it } from "vitest";
import { fileSides } from "./sides.js";

describe("fileSides", () => {
  it("spreads sides along imports, stopping at client and server boundaries", () => {
    const files = ["page.tsx", "chat.tsx", "util.ts", "actions.ts", "db.ts", "route.ts", "orphan.ts"];
    const imports = [
      { from: "page.tsx", to: "chat.tsx" },
      { from: "page.tsx", to: "util.ts" },
      { from: "chat.tsx", to: "util.ts" },
      { from: "chat.tsx", to: "actions.ts" },
      { from: "actions.ts", to: "db.ts" },
      { from: "route.ts", to: "db.ts" },
      { from: "route.ts", to: "pkg:next" },
    ];
    const roots = { client: new Set(["chat.tsx"]), server: new Set(["page.tsx", "actions.ts", "route.ts"]), actions: new Set(["actions.ts"]) };
    expect(Object.fromEntries(fileSides(files, imports, roots))).toEqual({
      "page.tsx": "server",
      "chat.tsx": "client",
      "util.ts": "shared",
      "actions.ts": "server",
      "db.ts": "server",
      "route.ts": "server",
    });
  });
});
