/** Archify-like palette: a strong border/text color and a soft fill per slot. */
const PALETTE = [
  { c: "#0f9f87", bg: "#e8f7f3" },
  { c: "#3b7ddd", bg: "#eaf1fd" },
  { c: "#8257e6", bg: "#f2edfd" },
  { c: "#d94a72", bg: "#fdedf2" },
  { c: "#d9821a", bg: "#fdf3e3" },
  { c: "#0b9cbf", bg: "#e5f6fa" },
  { c: "#4a9a35", bg: "#edf6e9" },
  { c: "#5f6f86", bg: "#f0f3f7" },
] as const;

const SYSTEM = { c: "#e0702a", bg: "#fff1e6" } as const;

export function colorOf(slot: number): { c: string; bg: string } {
  if (slot < 0) return SYSTEM;
  return PALETTE[slot % PALETTE.length] ?? PALETTE[0];
}

export function cssVars(slot: number): Record<string, string> {
  const { c, bg } = colorOf(slot);
  return { "--c": c, "--bg": bg };
}

/** "POST /api/send" → ["POST", "/api/send"]. */
export function splitLabel(label: string): [string, string] {
  const at = label.indexOf(" ");
  return at === -1 ? ["", label] : [label.slice(0, at), label.slice(at + 1)];
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");
