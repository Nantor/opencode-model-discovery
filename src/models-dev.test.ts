import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enhanceModelEntry,
  findModelsDevEntry,
  getModelsDevData,
} from "./models-dev.js";
import type { ModelsDevData, OpenCodeModelEntry } from "./types.js";

const sampleData: ModelsDevData = {
  openai: {
    id: "openai",
    npm: "@ai-sdk/openai",
    name: "OpenAI",
    models: {
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
    },
  },
  "google-vertex-anthropic": {
    id: "google-vertex-anthropic",
    npm: "@ai-sdk/google-vertex/anthropic",
    name: "Vertex (Anthropic)",
    models: {
      "claude-opus-4-5@20251101": {
        id: "claude-opus-4-5@20251101",
        name: "Claude Opus 4.5",
        family: "claude",
        reasoning: true,
        tool_call: true,
        limit: { context: 200000, output: 64000 },
        cost: { input: 5, output: 25 },
      },
    },
  },
  azure: {
    id: "azure",
    npm: "@ai-sdk/azure",
    name: "Azure",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt",
      },
    },
  },
  mistral: {
    id: "mistral",
    models: {
      "devstral-2512": {
        id: "devstral-2512",
        canonical_model_id: "mistral/devstral-2512",
        name: "Devstral 2",
      },
    },
  },
  google: {
    id: "google",
    models: {
      "gemini-3.6-flash": {
        id: "gemini-3.6-flash",
        canonical_model_id: "google/gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
      },
    },
  },
};

describe("findModelsDevEntry", () => {
  it("finds an unambiguous exact id match when litellm_provider is missing", () => {
    expect(findModelsDevEntry(sampleData, undefined, "unique")?.name).toBe("Unique Model");
  });

  it("strips a US regional route prefix for an unambiguous fallback match", () => {
    expect(findModelsDevEntry(sampleData, undefined, "US-unique")?.name).toBe("Unique Model");
  });

  it("uses a verified explicit alias when litellm_provider is missing", () => {
    expect(findModelsDevEntry(sampleData, undefined, "devstral-2-123b")?.name).toBe("Devstral 2");
    expect(findModelsDevEntry(sampleData, undefined, "US-gemini-3.6-flash")?.name).toBe(
      "Gemini 3.6 Flash",
    );
  });

  it("returns undefined for ambiguous matches when litellm_provider is missing", () => {
    expect(findModelsDevEntry(sampleData, undefined, "gpt-4o")).toBeUndefined();
  });

  it("returns undefined when litellm_provider has no known mapping", () => {
    expect(findModelsDevEntry(sampleData, "some-unknown-provider", "gpt-4o")).toBeUndefined();
  });

  it("finds a direct id match under the mapped provider", () => {
    const entry = findModelsDevEntry(sampleData, "azure", "azure/gpt-4o");
    expect(entry?.name).toBe("GPT-4o");
  });

  it("strips a redundant litellm provider prefix before lookup", () => {
    const entry = findModelsDevEntry(sampleData, "openai", "openai/gpt-4o");
    expect(entry).toBe(sampleData.openai.models["gpt-4o"]);
  });

  it("resolves vertex_ai-anthropic_models to google-vertex-anthropic and strips version suffixes correctly", () => {
    const entry = findModelsDevEntry(
      sampleData,
      "vertex_ai-anthropic_models",
      "vertex_ai/claude-opus-4-5@20251101",
    );
    expect(entry?.name).toBe("Claude Opus 4.5");
  });

  it("returns undefined when the mapped provider has no matching model id", () => {
    expect(findModelsDevEntry(sampleData, "openai", "openai/does-not-exist")).toBeUndefined();
  });

  it("returns undefined when the mapped provider is absent from the dataset", () => {
    expect(findModelsDevEntry({}, "openai", "gpt-4o")).toBeUndefined();
  });

  it("falls back to the raw id when the prefix does not match litellm_provider", () => {
    const entry = findModelsDevEntry(sampleData, "azure", "gpt-4o");
    expect(entry?.name).toBe("GPT-4o");
  });
});

describe("enhanceModelEntry", () => {
  it("fills undefined fields from the models.dev entry", () => {
    const modelEntry: OpenCodeModelEntry = { name: "Gpt 4o" };
    enhanceModelEntry(modelEntry, sampleData.openai.models["gpt-4o"]);

    expect(modelEntry.family).toBe("gpt");
    expect(modelEntry.release_date).toBe("2024-05-13");
    expect(modelEntry.temperature).toBe(true);
    expect(modelEntry.attachment).toBe(true);
    expect(modelEntry.reasoning).toBe(false);
    expect(modelEntry.tool_call).toBe(true);
    expect(modelEntry.limit).toEqual({ context: 128000, output: 16384 });
    expect(modelEntry.cost).toEqual({ input: 2.5, output: 10, cache_read: 1.25 });
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
    enhanceModelEntry(modelEntry, sampleData.openai.models["gpt-4o"]);

    expect(modelEntry.family).toBe("custom-family");
    expect(modelEntry.reasoning).toBe(true);
    expect(modelEntry.cost).toEqual({ input: 1, output: 1 });
    expect(modelEntry.limit).toEqual({ context: 1, output: 1 });
    expect(modelEntry.modalities).toEqual({ input: ["text"], output: ["text"] });
  });

  it("does not set limit or cost when the models.dev entry lacks required subfields", () => {
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

    await expect(getModelsDevData(undefined, undefined)).resolves.toEqual(sampleData);
    await rm(directory, { recursive: true, force: true });
  });

  it("logs a warning when OpenCode's local catalog is unavailable", async () => {
    cacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(tmpdir(), `missing-opencode-models-${Date.now()}`);
    const log = vi.fn();

    await expect(getModelsDevData(undefined, undefined, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("Could not read OpenCode models catalog"));
  });
});
