import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "@factory/droid-sdk/node";
import { DEFAULT_MODEL } from "../src/droid.js";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.FACTORY_API_KEY) throw new Error("FACTORY_API_KEY is not set (expected in .env at the repo root)");

const result = await run("Reply with exactly: Catchup is connected to Droid.", { modelId: DEFAULT_MODEL });
if (!result.success) throw new Error(result.error?.message ?? `Droid run failed: ${result.subtype}`);

console.log(result.text);
console.log("tokens:", result.tokenUsage);
