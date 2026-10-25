import type { Facts } from "./facts.js";
import { extractFunctions, MODULE_UNIT } from "./functions.js";
import { FUNCTION_HASH_VERSION } from "./hash.js";

/** Upgrade only hashes from immutable source, retaining all existing IDs and analysis metadata. */
export function refreshFunctionHashes(facts: Facts, readFile: (file: string) => string): Facts {
  if (facts.hashVersion === FUNCTION_HASH_VERSION || facts.functions.length === 0) return facts;
  if (facts.hashVersion !== undefined && facts.hashVersion !== 1) throw new Error(`unsupported function hash version ${facts.hashVersion}`);
  const hashes = new Map<string, string>();
  const modules = new Set(facts.functions.filter((fn) => fn.name === MODULE_UNIT).map((fn) => fn.file));
  for (const file of new Set(facts.functions.map((fn) => fn.file))) {
    for (const fn of extractFunctions(file, readFile(file), modules.has(file))) hashes.set(fn.id, fn.hash);
  }
  const functions = facts.functions.map((fn) => {
    const hash = hashes.get(fn.id);
    if (hash === undefined) throw new Error(`cached function ${fn.id} does not exist at ${facts.sha}; rerun catchup init --at ${facts.sha}`);
    return { ...fn, hash };
  });
  return { ...facts, hashVersion: FUNCTION_HASH_VERSION, functions };
}
