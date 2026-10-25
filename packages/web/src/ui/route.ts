/** Where the reader is: hash-based, so the browser's back button and reloads keep the place. */
export type Route = { view: "home" } | { view: "arch"; id: string } | { view: "flows"; id: string } | { view: "map" } | { view: "preview" } | { view: "timelapse" };

export function parseRoute(hash: string): Route | undefined {
  const [view, ...rest] = hash.replace(/^#\/?/, "").split("/");
  const id = decodeURIComponent(rest.join("/"));
  if (view === "home" || view === "map" || view === "preview" || view === "timelapse") return { view };
  if (view === "arch") return { view, id: id || "root" };
  if (view === "flows") return { view, id };
  return undefined;
}

export const formatRoute = (r: Route): string => (r.view === "arch" || r.view === "flows" ? `#/${r.view}/${encodeURIComponent(r.id)}` : `#/${r.view}`);
