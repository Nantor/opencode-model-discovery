import { describe, expect, it } from "vitest";

import { parseCacheDuration } from "./cache.js";

describe("parseCacheDuration", () => {
  it("parses fixed-length ISO 8601 durations", () => {
    expect(parseCacheDuration("PT1H30M")).toBe(5_400_000);
    expect(parseCacheDuration("P1DT2S")).toBe(86_402_000);
    expect(parseCacheDuration("P2W")).toBe(1_209_600_000);
    expect(parseCacheDuration("PT0.02S")).toBe(20);
  });

  it("rejects zero, calendar-relative, and malformed durations", () => {
    expect(parseCacheDuration("PT0S")).toBeUndefined();
    expect(parseCacheDuration("P1M")).toBeUndefined();
    expect(parseCacheDuration("P1Y")).toBeUndefined();
    expect(parseCacheDuration("3600000")).toBeUndefined();
    expect(parseCacheDuration(3_600_000)).toBeUndefined();
  });
});
