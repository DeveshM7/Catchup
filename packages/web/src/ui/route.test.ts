import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, type Route } from "./route";

describe("dashboard routes", () => {
  it("round trips code paths with hashes, slashes and spaces", () => {
    const route: Route = { view: "flows", id: "journey:ui:app/(chat)/input.tsx#send text" };
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("ignores malformed URL escapes instead of crashing the app", () => {
    expect(parseRoute("#/arch/%")).toBeUndefined();
    expect(parseRoute("#/arch/%E0%A4")).toBeUndefined();
    expect(parseRoute("#/arch/")).toEqual({ view: "arch", id: "root" });
  });
});
