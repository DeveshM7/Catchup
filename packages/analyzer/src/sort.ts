export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareImports(a: { from: string; to: string }, b: { from: string; to: string }): number {
  return compareStrings(a.from, b.from) || compareStrings(a.to, b.to);
}
