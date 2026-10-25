export function handlePart(part: { type: string; data: unknown }) {
  if (part.type === "data-title") {
    document.title = String(part.data);
  }
}
