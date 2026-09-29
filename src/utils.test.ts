import { describe, it, expect } from "vitest";

import { sortByKey, toDisplayName } from "./utils.js";

// ---------------------------------------------------------------------------
// toDisplayName
// ---------------------------------------------------------------------------

describe("toDisplayName", () => {
  it("capitalizes first letter of each word separated by hyphens", () => {
    expect(toDisplayName("gpt-4o-mini")).toBe("Gpt 4o Mini");
  });

  it("strips provider prefix before the slash", () => {
    expect(toDisplayName("openai/gpt-4o")).toBe("Gpt 4o");
  });

  it("handles a single word with no hyphens", () => {
    expect(toDisplayName("claude")).toBe("Claude");
  });

  it("handles multiple slash segments, keeping only the last", () => {
    expect(toDisplayName("anthropic/claude-3-haiku")).toBe("Claude 3 Haiku");
  });

  it("handles an id that is already a display name (no hyphens or slashes)", () => {
    expect(toDisplayName("Llama")).toBe("Llama");
  });

  it("strips trailing slash when the segment after the slash is empty", () => {
    expect(toDisplayName("openai/")).toBe("Openai");
  });

  it("strips trailing wildcard markers", () => {
    expect(toDisplayName("claude-opus-4-5*")).toBe("Claude Opus 4 5");
  });
});

// ---------------------------------------------------------------------------
// sortByKey
// ---------------------------------------------------------------------------

describe("sortByKey", () => {
  it("sorts object by nested string key", () => {
    const input = {
      z: { name: "Zebra" },
      a: { name: "Apple" },
      m: { name: "Monkey" },
    };
    const result = sortByKey(input, "name");
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
  });

  it("handles empty object", () => {
    const result = sortByKey({}, "name");
    expect(Object.keys(result)).toEqual([]);
  });

  it("handles single key object", () => {
    const input = { only: { name: "Only" } };
    const result = sortByKey(input, "name");
    expect(Object.keys(result)).toEqual(["only"]);
  });

  it("sorts numerically when values are numbers", () => {
    const input = {
      z: { value: 10 },
      a: { value: 2 },
      m: { value: 1 },
    };
    const result = sortByKey(input, "value");
    expect(Object.keys(result)).toEqual(["m", "a", "z"]);
  });

  it("uses empty string fallback for missing keys", () => {
    const input = {
      a: { name: "Apple" },
      z: {},
      m: { name: "Monkey" },
    };
    const result = sortByKey(input, "name");
    expect(Object.keys(result)).toEqual(["z", "a", "m"]);
  });

  it("handles mixed types in sort key", () => {
    const input = {
      a: { value: "abc" },
      z: { value: 123 },
      m: { value: "def" },
    };
    const result = sortByKey(input, "value");
    expect(Object.keys(result)).toEqual(["z", "a", "m"]);
  });

  it("preserves full nested objects while sorting", () => {
    const input = {
      z: { name: "Zebra", type: "animal" },
      a: { name: "Apple", type: "fruit" },
    };
    const result = sortByKey(input, "name");
    expect(result.a).toEqual({ name: "Apple", type: "fruit" });
    expect(result.z).toEqual({ name: "Zebra", type: "animal" });
  });
});
