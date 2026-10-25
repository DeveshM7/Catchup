export function handleError(error: unknown): void {
  process.exitCode = error ? 1 : 0;
}
