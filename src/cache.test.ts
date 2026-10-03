import { describe, expect, it } from "vitest";

import {
  createMemoryStorage,
  discoveryCacheKey,
  isArrayOf,
  parseCacheDuration,
  readCache,
  type Storage,
  writeCache,
} from "./cache.js";

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

describe("discoveryCacheKey", () => {
  it("creates prefixed cache keys with hashed api keys", () => {
    const key1 = discoveryCacheKey("models", "https://api.example.com", "secret-key");
    const key2 = discoveryCacheKey("models", "https://api.example.com", "secret-key");
    const keyNoAuth = discoveryCacheKey("models", "https://api.example.com");

    expect(key1).toBe(key2);
    expect(key1).toContain("discovery:models:https://api.example.com:");
    expect(key1).not.toContain("secret-key");
    expect(keyNoAuth).toContain("discovery:models:https://api.example.com:none");
  });
});

describe("readCache / writeCache with storage", () => {
  const isNumberArray = isArrayOf((value): value is number => typeof value === "number");

  it("round-trips a value", async () => {
    const storage = createMemoryStorage();
    await writeCache(storage, "key", [1, 2, 3]);
    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toEqual([1, 2, 3]);
  });

  it("treats a value that fails validation as a cache miss", async () => {
    const storage = createMemoryStorage();
    await writeCache(storage, "key", "not an array");
    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toBeUndefined();

    await writeCache(storage, "key", [1, "two"]);
    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toBeUndefined();
  });

  it("treats a malformed storage entry as a cache miss", async () => {
    const storage = createMemoryStorage();
    await storage.set("key", "not an object" as never);
    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toBeUndefined();

    await storage.set("key", { createdAt: "not a number", value: [1] } as never);
    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toBeUndefined();
  });

  it("treats an expired entry as a cache miss and removes it", async () => {
    const storage = createMemoryStorage();
    await storage.set("key", {
      createdAt: Date.now() - 120_000,
      value: [1],
    } as never);

    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toBeUndefined();
    await expect(storage.get("key")).resolves.toBeUndefined();
  });

  it("handles storage write and read errors gracefully", async () => {
    const brokenStorage: Storage = {
      async get() {
        throw new Error("storage get failed");
      },
      async set() {
        throw new Error("storage set failed");
      },
      async remove() {
        throw new Error("storage remove failed");
      },
      async scan() {
        return { entries: [] };
      },
    };

    await expect(writeCache(brokenStorage, "key", [1])).resolves.toBeUndefined();
    await expect(readCache(brokenStorage, "key", 60_000, isNumberArray)).resolves.toBeUndefined();
  });
});

describe("createMemoryStorage", () => {
  it("supports get, set, remove, and scan operations", async () => {
    const storage = createMemoryStorage();
    await storage.set("cache:1", "one" as never);
    await storage.set("cache:2", "two" as never);
    await storage.set("other:1", "other" as never);

    expect(await storage.get("cache:1")).toBe("one");
    expect(await storage.get("unknown")).toBeUndefined();

    const scanResult = await storage.scan({ prefix: "cache:" });
    expect(scanResult.entries).toHaveLength(2);

    await storage.remove("cache:1");
    expect(await storage.get("cache:1")).toBeUndefined();
  });
});
