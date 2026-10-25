import { describe, expect, it } from "vitest";
import { matchRoutes, PLACEHOLDER, routePattern, urlPath, type Route } from "./links.js";

const route = (method: string, url: string): Route => ({ method, url, entry: `http:${method} ${url}`, handler: `app${url}/route.ts#${method}` });
const routes = [route("GET", "/api/chat/[id]/stream"), route("POST", "/api/chat"), route("DELETE", "/api/chat"), route("GET", "/api/files/[...path]"), route("ANY", "/api/auth")];

describe("client → server links", () => {
  it("takes the path of a written URL", () => {
    expect(urlPath("/api/chat?id=1")).toBe("/api/chat");
    expect(urlPath(`${PLACEHOLDER}/api/chat/`)).toBe("/api/chat");
    expect(urlPath("https://example.com/api/chat#x")).toBe("/api/chat");
    expect(urlPath("//cdn.example.com/x.js")).toBeUndefined();
    expect(urlPath("text/plain")).toBeUndefined();
  });

  it("matches dynamic segments", () => {
    expect(routePattern("/api/chat/[id]/stream").test(`/api/chat/${PLACEHOLDER}/stream`)).toBe(true);
    expect(routePattern("/api/chat/[id]/stream").test("/api/chat/a/b/stream")).toBe(false);
    expect(routePattern("/api/files/[...path]").test("/api/files/a/b")).toBe(true);
  });

  it("picks routes by method and path", () => {
    expect(matchRoutes("/api/chat", "POST", routes).map((r) => r.entry)).toEqual(["http:POST /api/chat"]);
    expect(matchRoutes("/api/chat", undefined, routes).map((r) => r.entry)).toEqual(["http:POST /api/chat", "http:DELETE /api/chat"]);
    expect(matchRoutes(`/api/chat/${PLACEHOLDER}/stream`, "GET", routes).map((r) => r.entry)).toEqual(["http:GET /api/chat/[id]/stream"]);
    expect(matchRoutes("/api/auth", "POST", routes).map((r) => r.entry)).toEqual(["http:ANY /api/auth"]);
    expect(matchRoutes("/about", undefined, routes)).toEqual([]);
  });
});
