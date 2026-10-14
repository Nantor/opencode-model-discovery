import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enhanceModelEntry,
  findModelsDevEntry,
  getModelsDevData,
} from "./models-dev.js";
import type { ModelsDevData, ModelsDevModel, OpenCodeModelEntry } from "./types.js";

const sampleModels: Record<string, ModelsDevModel> = {
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
    cost: { input: 2.5, output: 10, cache_read: 1.25 },
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
    cost: { input: 5, output: 25 },
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
};

const sampleData: ModelsDevData = {
  gateway: { id: "gateway", models: sampleModels },
  other: { id: "other", models: { "gpt-4o": { id: "gpt-4o", name: "Duplicate model" } } },
};

describe("findModelsDevEntry", () => {
  it("removes configured prefixes and postfixes before searching all providers", () => {
    const options = { modelsDevIgnorePrefixes: ["EU-"], modelsDevIgnorePostfixes: ["-private"] };
    expect(findModelsDevEntry(sampleData, "EU-gpt-4o-private", options))
      .toBe(sampleModels["gpt-4o"]);
    expect(findModelsDevEntry(sampleData, "EU-unique-private", options))
      .toBe(sampleModels.unique);
  });

  it("cleans affixes even when the original ID exists in the catalog", () => {
    const cleaned = { id: "unique", name: "Cleaned route" };
    const data = { custom: { id: "custom", models: { unique: cleaned, "EU-unique": { id: "EU-unique" } } } };
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
    const model = { id: "vendor/group/unique", name: "Namespaced model" };
    const data = { unrelated: { id: "unrelated", models: { "different-key": model } } };
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
    const first = { id: "vendor/unique" };
    const data = { custom: { id: "custom", models: { "vendor/unique": first, unique: { id: "unique" } } } };
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

describe("enhanceModelEntry", () => {
  it("fills undefined fields from the models.dev entry", () => {
    const modelEntry: OpenCodeModelEntry = { name: "Gpt 4o" };
    enhanceModelEntry(modelEntry, sampleModels["gpt-4o"]);

    expect(modelEntry.family).toBe("gpt");
    expect(modelEntry.release_date).toBe("2024-05-13");
    expect(modelEntry.temperature).toBe(true);
    expect(modelEntry.attachment).toBe(true);
    expect(modelEntry.reasoning).toBe(false);
    expect(modelEntry.tool_call).toBe(true);
    expect(modelEntry.limit).toEqual({ context: 128000, output: 16384 });
    expect(modelEntry.cost).toBeUndefined();
    expect(modelEntry.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
  });

  it("never overwrites fields already populated from discovery", () => {
    const modelEntry: OpenCodeModelEntry = {
      name: "Gpt 4o",
      family: "custom-family",
      reasoning: true,
      cost: { input: 1, output: 1 },
      limit: { context: 1, output: 1 },
      modalities: { input: ["text"], output: ["text"] },
    };
    enhanceModelEntry(modelEntry, sampleModels["gpt-4o"]);

    expect(modelEntry.family).toBe("custom-family");
    expect(modelEntry.reasoning).toBe(true);
    expect(modelEntry.cost).toEqual({ input: 1, output: 1 });
    expect(modelEntry.limit).toEqual({ context: 1, output: 1 });
    expect(modelEntry.modalities).toEqual({ input: ["text"], output: ["text"] });
  });

  it("never fills missing pricing from the catalog", () => {
    const modelEntry: OpenCodeModelEntry = { name: "Test" };
    enhanceModelEntry(modelEntry, {
      id: "test",
      cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 3 },
    });
    expect(modelEntry.cost).toBeUndefined();
  });

  it("does not set limit when the models.dev entry lacks required subfields", () => {
    const modelEntry: OpenCodeModelEntry = { name: "Test" };
    enhanceModelEntry(modelEntry, {
      id: "test",
      limit: { context: 1000 },
      cost: { input: 1 },
    });

    expect(modelEntry.limit).toBeUndefined();
    expect(modelEntry.cost).toBeUndefined();
  });

  it("ignores non-boolean/non-string metadata types", () => {
    const modelEntry: OpenCodeModelEntry = { name: "Test" };
    enhanceModelEntry(modelEntry, {
      id: "test",
      family: 123 as unknown as string,
      reasoning: "yes" as unknown as boolean,
    });

    expect(modelEntry.family).toBeUndefined();
    expect(modelEntry.reasoning).toBeUndefined();
  });
});

describe("getModelsDevData", () => {
  let cacheHome: string | undefined;

  afterEach(() => {
    if (cacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = cacheHome;
  });

  it("reads OpenCode's local models catalog", async () => {
    const directory = join(tmpdir(), `opencode-models-${process.pid}-${Date.now()}`);
    cacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = directory;
    await mkdir(join(directory, "opencode"), { recursive: true });
    await writeFile(join(directory, "opencode", "models.json"), JSON.stringify(sampleData));

    await expect(getModelsDevData()).resolves.toEqual(sampleData);
    const data = await getModelsDevData();
    expect(data).toBeDefined();
    if (!data) throw new Error("Expected a provider-grouped models catalog");
    const match = findModelsDevEntry(data, "EU-seed-2.0-pro-private", {
      modelsDevIgnorePrefixes: ["EU-"],
      modelsDevIgnorePostfixes: ["-private"],
    });
    expect(match).toEqual(sampleModels["bytedance-seed/seed-2.0-pro"]);
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    null,
    [],
    { model: null },
    { model: [] },
    { model: {} },
    { model: { id: 123 } },
    { "gpt-4o": { id: "gpt-4o", name: "Flat model" } },
    { openai: { id: "openai", models: [] } },
    { openai: { id: "openai", models: { "gpt-4o": { id: 123 } } } },
  ])("rejects invalid or flat catalogs: %j", async (catalog) => {
    const directory = join(tmpdir(), `opencode-invalid-models-${process.pid}-${Date.now()}`);
    cacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = directory;
    await mkdir(join(directory, "opencode"), { recursive: true });
    try {
      await writeFile(join(directory, "opencode", "models.json"), JSON.stringify(catalog));
      await expect(getModelsDevData()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs a warning when OpenCode's local catalog is unavailable", async () => {
    cacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(tmpdir(), `missing-opencode-models-${Date.now()}`);
    const log = vi.fn();

    await expect(getModelsDevData(log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("Could not read OpenCode models catalog"));
  });
});
