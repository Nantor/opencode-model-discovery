import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as snapshotModels } from "@opencode-ai/models/snapshot";

import {
  enhanceModelInfo,
  findModelsDevEntry,
  getModelsDevData,
} from "./models-dev.js";
import type { DiscoveredModelInfo, ModelsDevData, ModelsDevModel } from "./types.js";
import { Model } from "@opencode/plugin";

const sampleModels: Record<string, ModelsDevModel> = Object.fromEntries(Object.entries({
  "gpt-4o": {
    id: "gpt-4o",
    name: "GPT-4o",
    family: "gpt",
    attachment: true,
    reasoning: false,
    tool_call: true,
    temperature: true,
    release_date: "2024-05-13",
    limit: { context: 128000, output: 16384 },
    modalities: { input: ["text", "image"], output: ["text"] },
  },
  unique: {
    id: "unique",
    name: "Unique Model",
  },
  "anthropic/claude-opus-4-5@20251101": {
    id: "anthropic/claude-opus-4-5@20251101",
    name: "Claude Opus 4.5",
    family: "claude",
    reasoning: true,
    tool_call: true,
    limit: { context: 200000, output: 64000 },
  },
  "azure/gpt-4o": {
    id: "azure/gpt-4o",
    name: "GPT-4o",
    family: "gpt",
  },
  "mistral/devstral-2512": {
    id: "mistral/devstral-2512",
    name: "Devstral 2",
  },
  "google/gemini-3.6-flash": {
    id: "google/gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
  },
  "bytedance-seed/seed-2.0-pro": {
    id: "bytedance-seed/seed-2.0-pro",
    name: "Seed 2.0 Pro",
    family: "seed",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    release_date: "2026-02-14",
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    limit: { context: 256000, output: 128000 },
  },
} satisfies Record<string, Omit<ModelsDevModel, "description">>).map(([id, model]) => [id, { ...model, description: "Test model" }]));

const sampleData: ModelsDevData = {
  ...sampleModels,
  duplicate: { id: "gpt-4o", name: "Duplicate model", description: "Test model" },
};

describe("findModelsDevEntry", () => {
  it("removes configured prefixes and postfixes before searching canonical models", () => {
    const options = { modelsDevIgnorePrefixes: ["EU-"], modelsDevIgnorePostfixes: ["-private"] };
    expect(findModelsDevEntry(sampleData, "EU-gpt-4o-private", options))
      .toBe(sampleModels["gpt-4o"]);
    expect(findModelsDevEntry(sampleData, "EU-unique-private", options))
      .toBe(sampleModels.unique);
  });

  it("cleans affixes even when the original ID exists in the catalog", () => {
    const cleaned = { id: "unique", name: "Cleaned route", description: "Test model" };
    const data = { unique: cleaned, "EU-unique": { id: "EU-unique", name: "Test", description: "Test model" } };
    expect(findModelsDevEntry(data, "EU-unique", { modelsDevIgnorePrefixes: ["EU-"] }))
      .toBe(cleaned);
  });

  it("uses the longest literal affix once and leaves interior and case-mismatched text alone", () => {
    const options = {
      modelsDevIgnorePrefixes: ["E", "EU-"],
      modelsDevIgnorePostfixes: ["e", "-private"],
    };
    expect(findModelsDevEntry(sampleData, "EU-unique-private", options))
      .toBe(sampleModels.unique);
    for (const id of ["eu-unique-private", "EU-EU-unique-private", "unique-private-interior"]) {
      expect(findModelsDevEntry(sampleData, id, options)).toBeUndefined();
    }
  });

  it("ignores invalid affix values and avoids empty lookup IDs", () => {
    const options = {
      modelsDevIgnorePrefixes: [null, "", 12, "EU-"] as unknown as string[],
      modelsDevIgnorePostfixes: "-private" as unknown as string[],
    };
    expect(findModelsDevEntry(sampleData, "EU-unique", options))
      .toBe(sampleModels.unique);
    expect(findModelsDevEntry(sampleData, "EU-", options)).toBeUndefined();
    expect(findModelsDevEntry(sampleData, "EU-unique-private", options)).toBeUndefined();
    expect(findModelsDevEntry(sampleData, "")).toBeUndefined();
    expect(findModelsDevEntry(sampleData, "-private", { modelsDevIgnorePostfixes: ["-private"] }))
      .toBeUndefined();
  });

  it("finds an exact ID anywhere in the catalog", () => {
    expect(findModelsDevEntry(sampleData, "unique")).toBe(sampleModels.unique);
    expect(findModelsDevEntry(sampleData, "claude-opus-4-5@20251101"))
      .toBe(sampleModels["anthropic/claude-opus-4-5@20251101"]);
  });

  it("matches a catalog model ID ending with the cleaned ID", () => {
    const model = { id: "vendor/group/unique", name: "Namespaced model", description: "Test model" };
    const data = { "different-key": model };
    expect(findModelsDevEntry(data, "unique")).toBe(model);
    expect(findModelsDevEntry(data, "EU-unique-private", {
      modelsDevIgnorePrefixes: ["EU-"],
      modelsDevIgnorePostfixes: ["-private"],
    })).toBe(model);
  });

  it("uses literal case-sensitive endsWith matching, not substring or reverse matching", () => {
    expect(findModelsDevEntry(sampleData, "4o")).toBe(sampleModels["gpt-4o"]);
    for (const id of ["GPT-4o", "gpt-4", "openai/gpt-4o", "devstral-2-123b"]) {
      expect(findModelsDevEntry(sampleData, id)).toBeUndefined();
    }
  });

  it("uses the first matching entry in catalog order when IDs share a suffix", () => {
    expect(findModelsDevEntry(sampleData, "gpt-4o")).toBe(sampleModels["gpt-4o"]);
  });

  it("uses catalog order without preferring exact matches over suffix matches", () => {
    const first = { id: "vendor/unique", name: "Test", description: "Test model" };
    const data = { "vendor/unique": first, unique: { id: "unique", name: "Test", description: "Test model" } };
    expect(findModelsDevEntry(data, "unique")).toBe(first);
  });

  it("only removes provider paths and regional prefixes when configured", () => {
    expect(findModelsDevEntry(sampleData, "US-unique")).toBeUndefined();
    expect(findModelsDevEntry(sampleData, "US-unique", { modelsDevIgnorePrefixes: ["US-"] }))
      .toBe(sampleModels.unique);
    expect(findModelsDevEntry(sampleData, "openai/EU-gpt-4o-private", {
      modelsDevIgnorePrefixes: ["openai/EU-"],
      modelsDevIgnorePostfixes: ["-private"],
    })).toBe(sampleModels["gpt-4o"]);
  });

  it("returns undefined for a missing model or empty catalog", () => {
    expect(findModelsDevEntry(sampleData, "does-not-exist")).toBeUndefined();
    expect(findModelsDevEntry({}, "gpt-4o")).toBeUndefined();
  });
});

describe("enhanceModelInfo", () => {
  it("fills undefined fields from the models.dev entry", () => {
    const modelEntry: DiscoveredModelInfo = { name: "Gpt 4o" };
    enhanceModelInfo(modelEntry, sampleModels["gpt-4o"]);

    expect(modelEntry.family).toBe("gpt");
    expect(modelEntry).not.toHaveProperty("release_date");
    expect(modelEntry).not.toHaveProperty("temperature");
    expect(modelEntry).not.toHaveProperty("attachment");
    expect(modelEntry.compatibility).toBeUndefined();
    expect(modelEntry.capabilities?.tools).toBe(true);
    expect(modelEntry.limit).toEqual({ context: 128000, output: 16384 });
    expect(modelEntry.cost).toBeUndefined();
    expect(modelEntry.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] });
  });

  it("never overwrites fields already populated from discovery", () => {
    const modelEntry: DiscoveredModelInfo = {
      name: "Gpt 4o",
      family: Model.Family.make("custom-family"),
      compatibility: { reasoningField: "reasoning_text" },
      cost: [],
      limit: { context: 1, output: 1 },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
    };
    enhanceModelInfo(modelEntry, sampleModels["gpt-4o"]);

    expect(modelEntry.family).toBe("custom-family");
    expect(modelEntry.compatibility).toEqual({ reasoningField: "reasoning_text" });
    expect(modelEntry.cost).toEqual([]);
    expect(modelEntry.limit).toEqual({ context: 1, output: 1 });
    expect(modelEntry.capabilities).toEqual({ tools: false, input: ["text"], output: ["text"] });
  });

  it("never fills missing pricing from the catalog", () => {
    const modelEntry: DiscoveredModelInfo = { name: "Test" };
    enhanceModelInfo(modelEntry, sampleModels["gpt-4o"]);
    expect(modelEntry.cost).toBeUndefined();
  });

  it("fills a missing input limit without replacing discovered limits", () => {
    const modelEntry: DiscoveredModelInfo = { limit: { context: 128000, output: 16384 } };
    enhanceModelInfo(modelEntry, {
      name: "GPT-4o", description: "Test model",
      id: "openai/gpt-4o",
      limit: { context: 256000, input: 120000, output: 32000 },
    });
    expect(modelEntry.limit).toEqual({ context: 128000, input: 120000, output: 16384 });
    enhanceModelInfo(modelEntry, { id: "openai/gpt-4o", name: "GPT-4o", description: "Test model", limit: { context: 128000, input: 100000 } });
    expect(modelEntry.limit?.input).toBe(120000);
  });

  it("supports canonical metadata without an output limit", () => {
    const modelEntry: DiscoveredModelInfo = {};
    enhanceModelInfo(modelEntry, {
      name: "GPT-4o", description: "Test model",
      id: "openai/gpt-4o",
      family: "gpt",
      limit: { context: 128000 },
    });
    expect(modelEntry.family).toBe("gpt");
    expect(modelEntry.limit).toEqual({ context: 128000 });
  });

  it("fills reasoning compatibility while preserving other compatibility settings", () => {
    const modelEntry: DiscoveredModelInfo = { compatibility: { maxTokensField: "max_completion_tokens" } };
    enhanceModelInfo(modelEntry, sampleModels["bytedance-seed/seed-2.0-pro"]);
    expect(modelEntry.compatibility).toEqual({ maxTokensField: "max_completion_tokens", reasoningField: "reasoning_content" });
  });

  it("ignores non-boolean/non-string metadata types", () => {
    const modelEntry: DiscoveredModelInfo = { name: "Test" };
    enhanceModelInfo(modelEntry, {
      name: "Test", description: "Test model",
      id: "test",
      family: 123 as unknown as ModelsDevModel["family"],
      reasoning: "yes" as unknown as boolean,
    });

    expect(modelEntry.family).toBeUndefined();
    expect(modelEntry.compatibility).toBeUndefined();
  });
});

describe("getModelsDevData", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the canonical catalog directly from models.dev with a timeout", async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json(sampleData));

    await expect(getModelsDevData()).resolves.toEqual(sampleData);
    expect(fetch).toHaveBeenCalledWith(new URL("https://models.dev/models.json"), expect.objectContaining({
      method: "GET",
      signal: expect.any(AbortSignal),
    }));
    const data = await getModelsDevData();
    expect(data).toBeDefined();
    if (!data) throw new Error("Expected a canonical models catalog");
    const match = findModelsDevEntry(data, "EU-seed-2.0-pro-private", {
      modelsDevIgnorePrefixes: ["EU-"],
      modelsDevIgnorePostfixes: ["-private"],
    });
    expect(match).toEqual(sampleModels["bytedance-seed/seed-2.0-pro"]);
  });

  it.each([
    null,
    [],
    { model: null },
    { model: [] },
    { model: {} },
    { model: { id: 123 } },
    { openai: { id: "openai", models: {} } },
    { openai: { id: "openai", models: [] } },
    { openai: { id: "openai", models: { "gpt-4o": { id: 123 } } } },
  ])("falls back to the snapshot for invalid or provider-grouped catalogs: %j", async (catalog) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(catalog));
    await expect(getModelsDevData()).resolves.toBe(snapshotModels);
  });

  it("logs a warning when models.dev is unavailable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network unavailable"));
    const log = vi.fn();

    await expect(getModelsDevData(log)).resolves.toBe(snapshotModels);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("falling back to bundled snapshot"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles HTTP errors without failing discovery", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await expect(getModelsDevData()).resolves.toBe(snapshotModels);
  });

  it("handles malformed JSON without failing discovery", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{ invalid json"));
    await expect(getModelsDevData()).resolves.toBe(snapshotModels);
  });
});
