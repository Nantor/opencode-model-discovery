import { describe, expect, it } from "vitest";

import {
  cacheModel,
  cacheModelInfo,
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
  it("creates versioned cache keys with hashed endpoint and api keys", () => {
    const key1 = discoveryCacheKey("models", "https://api.example.com", "secret-key");
    const key2 = discoveryCacheKey("models", "https://api.example.com", "secret-key");
    const keyNoAuth = discoveryCacheKey("models", "https://api.example.com");

    expect(key1).toBe(key2);
    expect(key1).toMatch(/^discovery:v2:models:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(key1).not.toContain("https://api.example.com");
    expect(key1).not.toContain("secret-key");
    expect(keyNoAuth).not.toBe(key1);
  });

  it("hashes URL userinfo and query credentials while retaining endpoint isolation", () => {
    const baseURL = "https://synthetic-user:synthetic-password@gateway/v1?token=synthetic-query";
    const original = discoveryCacheKey("models", baseURL);
    for (const secret of [baseURL, "synthetic-user", "synthetic-password", "synthetic-query"]) {
      expect(original).not.toContain(secret);
    }
    for (const part of ["synthetic-user", "synthetic-password", "synthetic-query", "gateway", "/v1"]) {
      expect(discoveryCacheKey("models", baseURL.replace(part, "changed"))).not.toBe(original);
    }
    expect(discoveryCacheKey("model-info", baseURL)).not.toBe(original);
  });

  it("isolates all effective auth/tenant headers without exposing secrets and ignores header casing/order", () => {
    const key = (headers: Record<string, string>, apiKey = "ignored-bearer"): string =>
      discoveryCacheKey("models", "https://gateway/v1", apiKey, headers);
    const headers = { Authorization: "Basic secret-auth", "X-API-Key": "secret-key", "X-Tenant": "secret-tenant" };
    const original = key(headers);
    expect(key({ "x-tenant": "secret-tenant", "x-api-key": "secret-key", authorization: "Basic secret-auth" }, "also-ignored"))
      .toBe(original);
    for (const name of Object.keys(headers)) {
      expect(key({ ...headers, [name]: "changed" })).not.toBe(original);
    }
    for (const value of Object.values(headers)) expect(original).not.toContain(value);
    expect(original).not.toContain("ignored-bearer");
    expect(key({})).not.toBe(original);
    expect(key({ Authorization: "first", authorization: "last" })).toBe(key({ authorization: "last" }));
    expect(key({ "X-Tenant": "a" }, "key-a")).not.toBe(key({ "X-Tenant": "a" }, "key-b"));
  });
});

describe("discovery cache projections", () => {
  it("retains every consumed metadata field, including zero and negative capability reports", () => {
    const model_info = {
      mode: "chat", max_tokens: 512, max_input_tokens: 200000, max_output_tokens: 4096,
      input_cost_per_token: 0, output_cost_per_token: 0.000002,
      cache_read_input_token_cost: 0.000003, cache_creation_input_token_cost: 0.000004,
      input_cost_per_token_above_200k_tokens: 0.000005, output_cost_per_token_above_200k_tokens: 0.000006,
      cache_read_input_token_cost_above_200k_tokens: 0.000007, cache_creation_input_token_cost_above_200k_tokens: 0.000008,
      supports_reasoning: false, reasoning: true, supports_function_calling: false, supports_tool_choice: true,
      supports_vision: false, supports_audio_input: true, supports_audio_output: false, supports_pdf_input: true,
      supported_openai_params: ["max_tokens", "max_completion_tokens"],
    };
    const entry = {
      model_name: "public-route*",
      litellm_params: { model: "upstream-alias", merge_reasoning_content_in_choices: false },
      model_info,
    };
    expect(cacheModelInfo(entry)).toEqual(entry);
    expect(cacheModelInfo({ ...entry, model_info: { ...model_info, max_tokens: "512", input_cost_per_token: "0" } }))
      .toEqual(entry);
    expect(cacheModel({ id: "public-route*", mode: "chat", object: "model", owned_by: "synthetic-owner-secret", created: 123 }))
      .toEqual({ id: "public-route*", mode: "chat" });
  });

  it("drops arbitrary nested payloads and validates values inside allowlisted fields", () => {
    const secret = { api_key: "synthetic-nested-secret" };
    const result = cacheModelInfo({
      model_name: "model", litellm_params: { api_key: "synthetic-upstream-secret", model: "alias", merge_reasoning_content_in_choices: secret },
      model_info: {
        key: "synthetic-key-secret", team_id: secret, provider_specific_entry: secret,
        input_cost_per_token: secret, max_tokens: "synthetic-numeric-secret", supports_reasoning: secret,
        supported_openai_params: ["max_tokens", "synthetic-param-secret", "temperature"],
      },
    } as never);
    expect(result).toEqual({
      model_name: "model", litellm_params: { model: "alias" },
      model_info: { supported_openai_params: ["max_tokens"] },
    });
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

  it("finishes delayed expiration removal before fetching and caching a replacement", async () => {
    const backing = createMemoryStorage();
    await backing.set("key", { createdAt: Date.now() - 120_000, value: [1] } as never);
    const removalStarted = Promise.withResolvers<void>();
    const releaseRemoval = Promise.withResolvers<void>();
    const events: string[] = [];
    const storage: Storage = {
      ...backing,
      async remove(key) {
        events.push("remove:start");
        removalStarted.resolve();
        await releaseRemoval.promise;
        await backing.remove(key);
        events.push("remove:end");
      },
      async set(key, value) {
        events.push("set");
        await backing.set(key, value);
      },
    };
    const fetchFresh = async (): Promise<number[]> => {
      events.push("fetch");
      return [2];
    };
    const refresh = async (): Promise<void> => {
      const cached = await readCache(storage, "key", 60_000, isNumberArray);
      if (cached === undefined) {
        await writeCache(storage, "key", await fetchFresh());
      }
    };

    const pending = refresh();
    await removalStarted.promise;
    releaseRemoval.resolve();
    await pending;

    expect(events).toEqual(["remove:start", "remove:end", "fetch", "set"]);
    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toEqual([2]);
  });

  it("treats rejected expiration removal as a miss and allows a replacement write", async () => {
    const backing = createMemoryStorage();
    await backing.set("key", { createdAt: Date.now() - 120_000, value: [1] } as never);
    const removedKeys: string[] = [];
    const storage: Storage = {
      ...backing,
      async remove(key) {
        removedKeys.push(key);
        throw new Error("storage remove failed");
      },
    };

    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toBeUndefined();
    expect(removedKeys).toEqual(["key"]);
    await expect(writeCache(storage, "key", [2])).resolves.toBeUndefined();
    await expect(readCache(storage, "key", 60_000, isNumberArray)).resolves.toEqual([2]);
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
  it.each([1, 2, 3, 6, 10])("traverses every matching entry exactly once with limit %i", async (limit) => {
    const storage = createMemoryStorage();
    for (const key of ["k:a", "other:1", "k:2", "k:á", "k:10", "other:2", "k:Z", "k:1"]) {
      await storage.set(key, { id: key });
    }
    const expected = ["k:1", "k:10", "k:2", "k:Z", "k:a", "k:á"];
    const seen: string[] = [];
    let after: string | undefined;
    // Bound the loop so a repeated/non-advancing cursor fails rather than hangs.
    for (let count = 0; count <= expected.length; count++) {
      const page = await storage.scan({ prefix: "k:", after, limit });
      expect(page.entries).toEqual(expected.slice(seen.length, seen.length + limit)
        .map((key) => ({ key, value: { id: key } })));
      seen.push(...page.entries.map(({ key }) => key));
      if (seen.length === expected.length) {
        expect(page.next).toBeUndefined();
        break;
      }
      expect(page.next).toBe(seen[seen.length - 1]);
      after = page.next;
    }
    expect(seen).toEqual(expected);
  });

  it("applies an exclusive key cursor before limiting and can resume after cursor deletion", async () => {
    const storage = createMemoryStorage();
    for (const key of ["k:3", "k:1", "k:2"]) await storage.set(key, key);
    const options = { prefix: "k:", after: "k:1", limit: 1 };
    const expected = { entries: [{ key: "k:2", value: "k:2" }], next: "k:2" };
    await expect(storage.scan(options)).resolves.toEqual(expected);
    await storage.remove("k:1");
    await expect(storage.scan(options)).resolves.toEqual(expected);
    await expect(storage.scan({ ...options, after: "k:15" })).resolves.toEqual(expected);
    await expect(storage.scan({ ...options, after: "j:" })).resolves.toEqual(expected);
    await expect(storage.scan({ ...options, after: "k:3" })).resolves.toEqual({ entries: [] });
    await expect(storage.scan({ ...options, after: "z:" })).resolves.toEqual({ entries: [] });
  });

  it("returns all sorted matches without a limit and treats an empty prefix/cursor literally", async () => {
    const storage = createMemoryStorage();
    await expect(storage.scan({ prefix: "", limit: 1 })).resolves.toEqual({ entries: [] });
    for (const key of ["b", "", "a"]) await storage.set(key, key);
    await expect(storage.scan({ prefix: "" })).resolves.toEqual({
      entries: [{ key: "", value: "" }, { key: "a", value: "a" }, { key: "b", value: "b" }],
    });
    await expect(storage.scan({ prefix: "", limit: 1 })).resolves.toEqual({
      entries: [{ key: "", value: "" }], next: "",
    });
    await expect(storage.scan({ prefix: "", after: "" })).resolves.toEqual({
      entries: [{ key: "a", value: "a" }, { key: "b", value: "b" }],
    });
    await expect(storage.scan({ prefix: "missing", limit: 1 })).resolves.toEqual({ entries: [] });
  });

  it.each([0, -1, 0.5, 1.5, NaN, Infinity, -Infinity])("rejects invalid page limit %s", async (limit) => {
    const storage = createMemoryStorage();
    await expect(storage.scan({ prefix: "", limit })).rejects.toThrow(RangeError);
    await storage.set("key", "value");
    await expect(storage.scan({ prefix: "", limit })).rejects.toThrow(RangeError);
  });

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
