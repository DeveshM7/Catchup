import { describe, expect, it } from "vitest";
import { detectExternals, externalFor, packageOfSpecifier } from "./externals.js";
import { packageName } from "./imports.js";

describe("packageName", () => {
  it.each([
    ["date-fns/locale", "date-fns"],
    ["@prisma/client/runtime", "@prisma/client"],
    ["react", "react"],
  ])("%s → %s", (spec, expected) => {
    expect(packageName(spec)).toBe(expected);
  });
});

describe("externals", () => {
  it("maps known packages and prefixes, ignores unknown ones", () => {
    expect(externalFor("pg")?.name).toBe("Postgres");
    expect(externalFor("@prisma/adapter-pg")?.name).toBe("Postgres");
    expect(externalFor("@aws-sdk/client-s3")?.name).toBe("AWS");
    expect(externalFor("left-pad")).toBeUndefined();
  });

  it("knows Drizzle drivers, AI SDK providers (not its UI hooks) and Vercel Blob", () => {
    expect(packageOfSpecifier("drizzle-orm/postgres-js")).toBe("drizzle-orm/postgres-js");
    expect(packageOfSpecifier("drizzle-orm/pg-core")).toBe("drizzle-orm");
    expect(externalFor("drizzle-orm/postgres-js")?.name).toBe("Postgres");
    expect(externalFor("drizzle-orm")).toBeUndefined();
    expect(externalFor("@ai-sdk/anthropic")?.id).toBe("ai-model");
    expect(externalFor("ai")?.id).toBe("ai-model");
    expect(externalFor("@ai-sdk/react")).toBeUndefined();
    expect(externalFor("@vercel/blob")?.id).toBe("blob");
  });

  it("groups packages by system and lists the components using it", () => {
    const byComponent = new Map([
      ["src/db", new Set(["pg", "react"])],
      ["src/jobs", new Set(["ioredis", "pg"])],
    ]);
    expect(detectExternals(byComponent)).toEqual([
      { id: "ext:postgres", name: "Postgres", packages: ["pg"], usedBy: ["src/db", "src/jobs"] },
      { id: "ext:redis", name: "Redis", packages: ["ioredis"], usedBy: ["src/jobs"] },
    ]);
  });
});
