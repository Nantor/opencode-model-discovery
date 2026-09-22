import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
};

describe("findModelsDevEntry", () => {
  it("returns undefined when litellm_provider is missing", () => {
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

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    cacheHome = process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (cacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = cacheHome;
    }
  });

  it("fetches and returns the models.dev catalog", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => sampleData,
    } as Response);

    const data = await getModelsDevData(undefined, undefined);
    expect(data).toEqual(sampleData);
    expect(fetch).toHaveBeenCalledWith(
      "https://models.dev/api.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns undefined and logs a warning on fetch failure", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    const log = vi.fn();

    const data = await getModelsDevData(undefined, undefined, log);
    expect(data).toBeUndefined();
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("network down"));
  });

  it("returns undefined and logs a warning on non-OK HTTP status", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);
    const log = vi.fn();

    const data = await getModelsDevData(undefined, undefined, log);
    expect(data).toBeUndefined();
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("HTTP 500"));
  });

  it("caches the response on disk and reuses it within the cache duration", async () => {
    const cacheDirectory = join(tmpdir(), `opencode-model-discovery-mdev-${process.pid}-${Date.now()}`);
    process.env.XDG_CACHE_HOME = cacheDirectory;
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => sampleData,
    } as Response);

    const first = await getModelsDevData(60_000, undefined);
    const second = await getModelsDevData(60_000, undefined);

    expect(first).toEqual(sampleData);
    expect(second).toEqual(sampleData);
    expect(fetch).toHaveBeenCalledTimes(1);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  it("de-duplicates concurrent in-flight fetches", async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.mocked(fetch).mockReturnValue(fetchPromise);

    const call1 = getModelsDevData(undefined, undefined);
    const call2 = getModelsDevData(undefined, undefined);

    resolveFetch({ ok: true, json: async () => sampleData } as Response);

    const [result1, result2] = await Promise.all([call1, call2]);
    expect(result1).toEqual(sampleData);
    expect(result2).toEqual(sampleData);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
