import { afterEach, describe, expect, it, vi } from "vitest";
import { analyze, type Facts } from "@catchup/analyzer";
import type { Understanding } from "@catchup/agent";
import { Preview } from "./preview.js";

vi.mock("@catchup/analyzer", async (importOriginal) => ({
  ...await importOriginal<typeof import("@catchup/analyzer")>(),
  analyze: vi.fn(),
}));

const facts: Facts = { sha: "head", files: [], functions: [], imports: [], calls: [], entryPoints: [] };
const understanding: Understanding = {
  sha: "head", model: "m", summary: "", parts: [], journeys: [], systems: [], otherFlows: [], nodes: {}, basis: "",
};

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("preview shutdown with analysis in flight", () => {
  it("does not restart a queued analysis after stop", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    vi.mocked(analyze).mockRejectedValue(new Error("unexpected extra analysis"));
    vi.mocked(analyze).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const preview = new Preview({ repoRoot: "/unused", head: { understanding, facts } }, 10);
    const running = preview.run();
    await preview.run(); // A save arrives while the first analysis is still running.
    await preview.stop();
    fail(new Error("analysis ended during shutdown"));
    await running;
    await vi.advanceTimersByTimeAsync(20);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("still processes a queued save after a failed analysis while active", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    vi.mocked(analyze).mockRejectedValue(new Error("second analysis failed"));
    vi.mocked(analyze).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const preview = new Preview({ repoRoot: "/unused", head: { understanding, facts } }, 10);
    const running = preview.run();
    await preview.run();
    fail(new Error("first analysis failed"));
    await running;
    await vi.advanceTimersByTimeAsync(20);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(preview.current().error).toBe("second analysis failed");
    await preview.stop();
  });
});
