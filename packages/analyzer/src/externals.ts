import type { ExternalSystem } from "./snapshot.js";
import { compareStrings } from "./sort.js";

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * `packages` may hold a subpath (`drizzle-orm/postgres-js`) when only that entry point talks to the
 * system; `exclude` drops UI-only packages that match a prefix.
 */
type Rule = { id: string; name: string; packages: string[]; prefixes?: string[]; exclude?: string[]; kind?: "tool" };

/** Package → external system. Not exhaustive: unknown packages stay as plain `pkg:` imports. */
export const EXTERNAL_SYSTEMS: Rule[] = [
  {
    id: "postgres",
    name: "Postgres",
    packages: [
      "pg",
      "postgres",
      "pg-promise",
      "slonik",
      "@neondatabase/serverless",
      "@vercel/postgres",
      "drizzle-orm/postgres-js",
      "drizzle-orm/node-postgres",
      "drizzle-orm/neon-http",
      "drizzle-orm/neon-serverless",
      "drizzle-orm/vercel-postgres",
      "drizzle-orm/pglite",
    ],
    prefixes: ["@prisma/"],
  },
  { id: "mysql", name: "MySQL", packages: ["mysql", "mysql2", "@planetscale/database", "drizzle-orm/mysql2", "drizzle-orm/planetscale-serverless"] },
  { id: "sqlite", name: "SQLite", packages: ["sqlite3", "better-sqlite3", "@libsql/client", "drizzle-orm/better-sqlite3", "drizzle-orm/libsql", "drizzle-orm/d1"] },
  { id: "mongodb", name: "MongoDB", packages: ["mongodb", "mongoose"] },
  { id: "clickhouse", name: "ClickHouse", packages: ["@clickhouse/client"] },
  { id: "redis", name: "Redis", packages: ["redis", "ioredis", "@upstash/redis"], prefixes: ["@redis/"] },
  { id: "kafka", name: "Kafka", packages: ["kafkajs", "@confluentinc/kafka-javascript"] },
  { id: "rabbitmq", name: "RabbitMQ", packages: ["amqplib"] },
  { id: "job-queue", name: "Job queue (BullMQ)", packages: ["bullmq", "bull"] },
  { id: "nats", name: "NATS", packages: ["nats"] },
  { id: "elasticsearch", name: "Elasticsearch", packages: ["@elastic/elasticsearch"] },
  { id: "meilisearch", name: "Meilisearch", packages: ["meilisearch"] },
  { id: "algolia", name: "Algolia", packages: ["algoliasearch"] },
  { id: "stripe", name: "Stripe", packages: ["stripe", "@stripe/stripe-js"] },
  { id: "aws", name: "AWS", packages: ["aws-sdk"], prefixes: ["@aws-sdk/"] },
  { id: "gcp", name: "Google Cloud", packages: [], prefixes: ["@google-cloud/"] },
  { id: "azure", name: "Azure", packages: [], prefixes: ["@azure/"] },
  { id: "firebase", name: "Firebase", packages: ["firebase", "firebase-admin"] },
  { id: "supabase", name: "Supabase", packages: ["@supabase/supabase-js"] },
  { id: "email", name: "Email", packages: ["nodemailer", "@sendgrid/mail", "resend", "postmark"] },
  { id: "twilio", name: "Twilio", packages: ["twilio"] },
  { id: "openai", name: "OpenAI", packages: ["openai"] },
  { id: "anthropic", name: "Anthropic", packages: ["@anthropic-ai/sdk"] },
  { id: "ai-model", name: "AI model (AI SDK)", packages: ["ai"], prefixes: ["@ai-sdk/"], exclude: ["@ai-sdk/react", "@ai-sdk/vue", "@ai-sdk/svelte", "@ai-sdk/ui-utils"] },
  { id: "blob", name: "Blob storage (Vercel)", packages: ["@vercel/blob"] },
  { id: "sentry", name: "Sentry", packages: [], prefixes: ["@sentry/"] },
  { id: "posthog", name: "PostHog", packages: ["posthog-node", "posthog-js"] },
  { id: "maxmind", name: "MaxMind GeoIP", packages: ["maxmind", "@maxmind/geoip2-node"] },
  { id: "slack", name: "Slack", packages: [], prefixes: ["@slack/"] },
  { id: "github", name: "GitHub API", packages: [], prefixes: ["@octokit/"] },
  { id: "clerk", name: "Clerk", packages: [], prefixes: ["@clerk/"] },
  { id: "auth0", name: "Auth0", packages: ["auth0", "@auth0/nextjs-auth0"] },
  // Tools (D53): compilers, bundlers and minifiers a build tool drives. Shown like systems, labelled as tools.
  { id: "esbuild", name: "esbuild", packages: ["esbuild"], kind: "tool" },
  { id: "rollup", name: "Rollup", packages: ["rollup", "rollup-plugin-dts"], prefixes: ["@rollup/"], kind: "tool" },
  { id: "webpack", name: "webpack", packages: ["webpack"], kind: "tool" },
  { id: "vite", name: "Vite", packages: ["vite"], kind: "tool" },
  { id: "typescript", name: "TypeScript compiler", packages: ["typescript"], kind: "tool" },
  { id: "babel", name: "Babel", packages: [], prefixes: ["@babel/"], kind: "tool" },
  { id: "swc", name: "SWC", packages: ["@swc/core"], kind: "tool" },
  { id: "sucrase", name: "Sucrase", packages: ["sucrase"], kind: "tool" },
  { id: "terser", name: "Terser", packages: ["terser"], kind: "tool" },
  { id: "postcss", name: "PostCSS", packages: ["postcss", "postcss-load-config"], kind: "tool" },
  { id: "svelte-compiler", name: "Svelte compiler", packages: ["svelte/compiler", "svelte-preprocess"], kind: "tool" },
  { id: "api-extractor", name: "API Extractor", packages: ["@microsoft/api-extractor"], kind: "tool" },
];

export function externalFor(pkg: string): Rule | undefined {
  return EXTERNAL_SYSTEMS.find(
    (r) => r.packages.includes(pkg) || ((r.prefixes ?? []).some((p) => pkg.startsWith(p)) && !(r.exclude ?? []).includes(pkg)),
  );
}

/** Package an import specifier names; keeps a subpath that a rule lists (`drizzle-orm/postgres-js`). */
export function packageOfSpecifier(spec: string): string {
  return EXTERNAL_SYSTEMS.some((r) => r.packages.includes(spec)) ? spec : packageName(spec);
}

export function detectExternals(packagesByComponent: Map<string, Set<string>>): ExternalSystem[] {
  const found = new Map<string, { rule: Rule; packages: Set<string>; usedBy: Set<string> }>();
  for (const [component, packages] of packagesByComponent) {
    for (const pkg of packages) {
      const rule = externalFor(pkg);
      if (rule === undefined) continue;
      const entry = found.get(rule.id) ?? { rule, packages: new Set<string>(), usedBy: new Set<string>() };
      entry.packages.add(pkg);
      entry.usedBy.add(component);
      found.set(rule.id, entry);
    }
  }
  return [...found.values()]
    .map(({ rule, packages, usedBy }): ExternalSystem => ({
      id: `ext:${rule.id}`,
      name: rule.name,
      ...(rule.kind ? { kind: rule.kind } : {}),
      packages: [...packages].sort(compareStrings),
      usedBy: [...usedBy].sort(compareStrings),
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
}
