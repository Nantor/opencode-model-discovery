import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyDiscovery } from "./plugin.js";
import type { OpenCodeConfig } from "./types.js";

function loadFixture(name: string): unknown {
  const file = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../test/fixtures",
    name,
  );
  return JSON.parse(readFileSync(file, "utf8"));
}

const v1Models = loadFixture("v1.models.json") as { data: { id: string }[] };
const v2ModelInfo = loadFixture("v2.model.info.json") as {
  data: {
    model_name: string;
    litellm_params: { model: string };
    model_info: Record<string, unknown>;
  }[];
};

function stubFetchFromFixtures(): void {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = input.toString();
    const body = url.includes("/model/info") ? v2ModelInfo : v1Models;
    return { ok: true, json: async () => body } as Response;
  });
}

describe("applyDiscovery with real fixture responses", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("filters endpoint-only models reported by /v1/models", async () => {
    stubFetchFromFixtures();

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const models = config?.provider?.gateway?.models ?? {};
    expect(fetch).toHaveBeenCalledTimes(2);

    const endpointOnlyModelIDs = new Set(
      v2ModelInfo.data
        .filter((entry) => entry.model_info.mode === "embedding")
        .map((entry) => entry.model_name),
    );
    for (const model of v1Models.data) {
      if (endpointOnlyModelIDs.has(model.id)) continue;
      expect(models[model.id]).toBeDefined();
    }
    expect(models["qwen-3-vl-embedding-2b-sovereign"]).toBeUndefined();
    expect(models["gemini-2.5-flash-image"]).toBeDefined();
  });

  it("preserves wildcard route ids reported by /v1/models", async () => {
    stubFetchFromFixtures();

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const models = config?.provider?.gateway?.models ?? {};
    const ids = Object.keys(models);

    for (const entry of v2ModelInfo.data) {
      if (!entry.model_name.endsWith("*")) continue;
      const id = entry.model_name;
      expect(ids).toContain(id);
      expect(models[id]?.reasoning).toBe(true);
      expect(models[id]?.tool_call).toBe(true);
      expect(models[id]?.limit).toBeDefined();
    }
  });

  it("applies limits and capabilities from detailed model info", async () => {
    stubFetchFromFixtures();

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const models = config?.provider?.gateway?.models ?? {};

    const gpt4o = models["gpt-4o"];
    expect(gpt4o?.limit).toEqual({
      context: 16384,
      output: 16384,
      input: 128000,
    });
    expect(gpt4o?.attachment).toBe(true);
    expect(gpt4o?.tool_call).toBe(true);

    const deepseek = models["deepseek-v4-flash-sovereign"];
    expect(deepseek?.reasoning).toBe(true);
    expect(deepseek?.tool_call).toBe(true);
    expect(deepseek?.limit?.input).toBe(220000);

    const imageModel = models["claude-opus-4-5*"];
    expect(imageModel?.modalities).toEqual({
      input: ["text", "image", "pdf"],
      output: ["text"],
    });
  });

  it("computes cost from per-token pricing in the fixture", async () => {
    stubFetchFromFixtures();

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const models = config?.provider?.gateway?.models ?? {};
    const gpt4o = models["gpt-4o"];
    // 2.75e-06 and 1.1e-05 per token -> per-million-token prices, plus the
    // cache_read tier reported in the fixture (1.25e-06 per token).
    expect(gpt4o?.cost).toEqual({ input: 2.75, output: 11, cache_read: 1.25 });

    const claude = models["claude-opus-4-5*"];
    expect(claude?.cost).toEqual({
      input: 5.5,
      output: 27.5,
      cache_read: 0.55,
      cache_write: 6.875,
    });
  });

  it("prefers max_completion_tokens for models that accept it", async () => {
    stubFetchFromFixtures();

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const transform = config?.provider?.gateway?.options?.transformRequestBody as
      | ((body: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    expect(transform).toBeDefined();

    // US-gpt-6-astra supports both max_tokens and max_completion_tokens in the
    // fixture; the transform should prefer max_completion_tokens.
    expect(
      transform?.({ model: "US-gpt-6-astra", max_tokens: 1000 }),
    ).toEqual({ model: "US-gpt-6-astra", max_completion_tokens: 1000 });
  });

  it("keeps explicit models configured before discovery", async () => {
    stubFetchFromFixtures();

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
          models: { "gpt-4o": { name: "My GPT-4o" } },
        },
      },
    };

    await applyDiscovery(config);

    expect(config?.provider?.gateway?.models?.["gpt-4o"]?.name).toBe("My GPT-4o");
  });
});
