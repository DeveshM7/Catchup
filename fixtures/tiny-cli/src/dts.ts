import { parentPort } from "node:worker_threads";
import ts from "typescript";

/** A class without a constructor: `new Pool()` runs nothing of ours and is not a runtime-only call. */
class Pool {
  names: string[] = [];
  add(name: string): void {
    this.names.push(name);
  }
}

function emitTypes(files: string[]): void {
  const pool = new Pool();
  pool.add("index");
  ts.createProgram(files, { declaration: true }).emit();
}

parentPort?.on("message", (files: string[]) => emitTypes(files));
