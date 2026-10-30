import type { Context } from "@opencode/plugin/promise/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelsDevData } from "./types.js";

import { createMemoryStorage, discoveryCacheKey, writeCache } from "./cache.js";
import { applyDiscovery, ModelDiscoveryPlugin } from "./plugin.js";
import type { OpenCodeConfig, OpenCodeProvider } from "./types.js";

function providerFor(config: OpenCodeConfig, id: string): OpenCodeProvider {
  const provider = config.provider?.[id];
  expect(provider).toBeDefined();
  return provider!;
}

describe("applyDiscovery", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it("only discovers models for opted-in providers", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      return {
        ok: true,
        json: async () =>
          url.includes("/models")
            ? { data: [{ id: "openai/gpt-4o-mini" }] }
            : {
                data: [
                  {
                    model_name: "openai/gpt-4o-mini",
                    litellm_params: { model: "openai/gpt-4o-mini" },
                    model_info: { max_tokens: 128000, max_output_tokens: 16384 },
                  },
                ],
              },
      } as Response;
    });

    const config: OpenCodeConfig = {
      provider: {
        enabled: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://localhost:4000/v1", "opencode-model-discovery": { discovery: true } },
        },
        disabled: {
          options: { baseURL: "http://localhost:5000/v1" },
        },
      },
    };

    await applyDiscovery(config);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(providerFor(config, "enabled").models?.["openai/gpt-4o-mini"]?.name).toBe(
      "Gpt 4o Mini",
    );
    expect(providerFor(config, "disabled").models).toBeUndefined();
    expect(providerFor(config, "enabled").options).not.toHaveProperty("opencode-model-discovery");
  });

  it("uses discoveryBaseURL for discovery while preserving baseURL for model requests", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }] }
          : { data: [] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: {
            baseURL: "https://inference.example.com/v1",
            "opencode-model-discovery": {
              discovery: true,
              discoveryBaseURL: "https://discovery.example.com/v1",
            },
          },
        },
      },
    };

    await applyDiscovery(config);

    expect(fetch).toHaveBeenCalledWith(
      "https://discovery.example.com/v1/models?return_wildcard_routes=true",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://discovery.example.com/v2/model/info?return_wildcard_routes=true",
      expect.any(Object),
    );
    expect(providerFor(config, "gateway").options?.baseURL).toBe(
      "https://inference.example.com/v1",
    );
    expect(providerFor(config, "gateway").options).not.toHaveProperty("opencode-model-discovery");
  });

  it("warns about an invalid discoveryCache value and discovers without caching", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }] }
          : { data: [] },
    }) as Response);
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: {
            baseURL: "https://llm.example.com/v1",
            "opencode-model-discovery": { discovery: true, discoveryCache: "1h" },
          },
        },
      },
    };
    const log = vi.fn();

    await applyDiscovery(config, log);

    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining('Ignoring invalid discoveryCache "1h"'));
    expect(providerFor(config, "gateway").models?.["gpt-4o"]).toBeDefined();
  });

  it("de-duplicates model ids repeated by /v1/models", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }, { id: "gpt-4o" }] }
          : { data: [] },
    }) as Response);
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };
    const log = vi.fn();

    await applyDiscovery(config, log);

    expect(Object.keys(providerFor(config, "gateway").models ?? {})).toEqual(["gpt-4o"]);
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("Discovered 1 usable model(s)"));
  });

  it("ignores undefined provider entries", async () => {
    const config: OpenCodeConfig = {
      provider: {
        unavailable: undefined,
      },
    };

    await expect(applyDiscovery(config)).resolves.toBeUndefined();
  });

  it("keeps manually configured models over discovered values", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }, { id: "claude-3-5-sonnet" }] }
          : { data: [] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          options: { baseURL: "http://localhost:4000", "opencode-model-discovery": { discovery: true } },
          models: { "gpt-4o": { name: "My GPT" } },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "litellm").models?.["gpt-4o"]?.name).toBe("My GPT");
    expect(providerFor(config, "litellm").models?.["claude-3-5-sonnet"]?.name).toBe(
      "Claude 3 5 Sonnet",
    );
  });

  it("keeps manual overrides for model ids with special characters", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "llama3.1:8b" }] }
          : { data: [] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          options: { baseURL: "http://localhost:4000", "opencode-model-discovery": { discovery: true } },
          models: { "llama3.1:8b": { name: "My Llama" } },
        },
      },
    };

    await applyDiscovery(config);

    expect(Object.keys(providerFor(config, "litellm").models ?? {})).toEqual(["llama3.1:8b"]);
    expect(providerFor(config, "litellm").models?.["llama3.1:8b"]?.name).toBe("My Llama");
  });

  it.each([true, false, undefined])("enriches configured models only when enrichExistingModels is true (%s)", async (enrichExistingModels) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => Response.json(
      input.toString().includes("/models")
        ? { data: [{ id: "gpt-4o" }, { id: "new-model" }] }
        : { data: [{ model_name: "gpt-4o", litellm_params: {}, model_info: {
          max_input_tokens: 128000, max_output_tokens: 16384,
          input_cost_per_token: 0.000002, output_cost_per_token: 0.000008,
          cache_read_input_token_cost: 0.000001,
          supports_function_calling: true, supports_reasoning: true, supports_vision: true,
        } }] },
    ));
    const manual = {
      name: "My GPT", tool_call: false, reasoning: false,
      limit: { context: 64000, output: 0 },
      cost: { input: 0, output: 4 },
      modalities: { input: [] as [], output: [] as [] },
      options: { reasoningSummary: null },
    };
    const config: OpenCodeConfig = { provider: { gateway: {
      options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": {
        discovery: true, enrichExistingModels,
      } },
      models: { "gpt-4o": manual, "manual-only": { name: "Manual only" } },
    } } };

    await applyDiscovery(config);

    const provider = providerFor(config, "gateway");
    expect(provider.models?.["gpt-4o"]).toEqual(enrichExistingModels ? {
      ...manual, attachment: true,
      limit: { ...manual.limit, input: 128000 },
      cost: { ...manual.cost, cache_read: 1 },
    } : manual);
    expect(manual.limit).toEqual({ context: 64000, output: 0 });
    expect(manual.cost).toEqual({ input: 0, output: 4 });
    expect(provider.models?.["manual-only"]).toEqual({ name: "Manual only" });
    expect(provider.models?.["new-model"]).toEqual({ name: "New Model" });
    expect(provider.options).not.toHaveProperty("opencode-model-discovery");
  });

  it("keeps basic discovery when detailed model info fails", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (input.toString().includes("/model/info")) {
        return { ok: false, status: 404, statusText: "Not Found" } as Response;
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: "model-a" }] }),
      } as Response;
    });

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "gateway").models?.["model-a"]?.name).toBe("Model A");
  });

  it("ignores malformed detailed model info entries", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "model-a" }] }
          : { data: [null, { model_name: "broken" }] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "gateway").models?.["model-a"]?.name).toBe("Model A");
  });

  it.each(["HTTP", "cache"])("preserves good models and basic discovery with malformed %s metadata", async (source) => {
    const baseURL = "https://metadata-test.example.com/v1";
    const storage = createMemoryStorage();
    const malformed = [
      { model_info: { mode: 42 } },
      { model_info: { supported_openai_params: {} } },
      { model_info: { supported_openai_params: "max_completion_tokens" } },
      { model_info: { supported_openai_params: ["max_completion_tokens", {}] } },
      { litellm_params: { model: { upstream: "good" } } },
      { litellm_params: { model: ["good"] } },
      { model_info: [] },
      { litellm_params: [] },
      { model_info: null },
      { litellm_params: null },
    ].map((fields, index) => ({
      model_name: `bad-${index}`, litellm_params: {}, model_info: {}, ...fields,
    }));
    const entries = [
      ...malformed,
      null,
      [],
      { model_name: 42, litellm_params: {}, model_info: {} },
      {
        model_name: "good",
        litellm_params: { model: "upstream-good" },
        model_info: {
          mode: "CHAT", max_input_tokens: 8192, max_output_tokens: 1024,
          supported_openai_params: ["max_completion_tokens"], supports_vision: false,
        },
      },
      { model_name: "wildcard*", litellm_params: {}, model_info: { supports_function_calling: true } },
      { model_name: "embedding", litellm_params: {}, model_info: { mode: "embedding" } },
      {
        model_name: "bad-scalars", litellm_params: { merge_reasoning_content_in_choices: {} },
        model_info: {
          max_input_tokens: {}, max_output_tokens: [], input_cost_per_token: {}, output_cost_per_token: [],
          supports_reasoning: "true", supports_vision: [], supports_function_calling: "true",
        },
      },
    ];
    const models = [...malformed.map((entry) => ({ id: entry.model_name })),
      { id: "upstream-good" }, { id: "basic-only" }, { id: "embedding" }, { id: "bad-scalars" }];
    if (source === "cache") {
      // Seed the raw shape accepted by older releases, including bad entries.
      await writeCache(storage, discoveryCacheKey("models", baseURL), models);
      await writeCache(storage, discoveryCacheKey("model-info", baseURL), entries);
      vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    } else {
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
        ok: true,
        json: async () => ({ data: input.toString().includes("/model/info") ? entries : models }),
      }) as Response);
    }
    const config: OpenCodeConfig = {
      provider: {
        gateway: { options: { baseURL, "opencode-model-discovery": { discovery: true, discoveryCache: "PT1H" } } },
      },
    };
    const log = vi.fn();

    await applyDiscovery(config, log, storage);

    const provider = providerFor(config, "gateway");
    expect(Object.keys(provider.models ?? {}).sort()).toEqual([
      ...malformed.map((entry) => entry.model_name), "good", "wildcard*", "basic-only", "bad-scalars",
    ].sort());
    expect(provider.models?.good).toMatchObject({
      limit: { context: 8192, input: 8192, output: 1024 }, attachment: false,
    });
    expect(provider.models?.["wildcard*"]?.tool_call).toBe(true);
    for (const entry of malformed) {
      expect(provider.models?.[entry.model_name]).toEqual({ name: expect.any(String) });
    }
    expect(provider.models?.["bad-scalars"]).toEqual({ name: "Bad Scalars" });
    const transform = provider.options?.transformRequestBody as (body: Record<string, unknown>) => Record<string, unknown>;
    expect(transform({ model: "good", max_tokens: 100 })).toEqual({ model: "good", max_completion_tokens: 100 });
    expect(transform({ model: "bad-2", max_tokens: 100 })).toEqual({ model: "bad-2", max_tokens: 100 });
    expect(log).not.toHaveBeenCalledWith("error", expect.any(String));
    expect(fetch).toHaveBeenCalledTimes(source === "cache" ? 0 : 2);
  });

  it("prefers exact metadata matches over aliases", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }] }
          : {
              data: [
                {
                  model_name: "gpt-4o",
                  litellm_params: { model: "upstream-gpt-4o" },
                  model_info: { max_input_tokens: 128000, max_output_tokens: 4096 },
                },
                {
                  model_name: "alias",
                  litellm_params: { model: "gpt-4o" },
                  model_info: { max_input_tokens: 999, max_output_tokens: 100 },
                },
              ],
            },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "gateway").models?.["gpt-4o"]?.limit).toEqual({
      context: 128000,
      input: 128000,
      output: 4096,
    });
  });

  it("uses max_completion_tokens only for models that require it", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "US-gpt-6-astra" }, { id: "gpt-4o" }] }
          : {
              data: [
                {
                  model_name: "US-gpt-6-astra",
                  litellm_params: { model: "US-gpt-6-astra" },
                  model_info: {
                    supported_openai_params: ["max_completion_tokens"],
                  },
                },
                {
                  model_name: "gpt-4o",
                  litellm_params: { model: "gpt-4o" },
                  model_info: { supported_openai_params: ["max_tokens"] },
                },
              ],
            },
    }) as Response);
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const transform = providerFor(config, "gateway").options?.transformRequestBody as
      | ((body: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    expect(transform?.({ model: "US-gpt-6-astra", max_tokens: 1000 })).toEqual({
      model: "US-gpt-6-astra",
      max_completion_tokens: 1000,
    });
    expect(transform?.({ model: "gpt-4o", max_tokens: 1000 })).toEqual({
      model: "gpt-4o",
      max_tokens: 1000,
    });
  });

  it("does not add a token transform without compatible metadata", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }] }
          : { data: [{ model_name: "gpt-4o", litellm_params: { model: "gpt-4o" }, model_info: {} }] },
    }) as Response);
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "gateway").options).not.toHaveProperty("transformRequestBody");
  });

  it("filters models for endpoint-only APIs", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? {
              data: [
                { id: "gpt-4o" },
                { id: "text-embedding-3-small" },
                { id: "gpt-image-1" },
                { id: "provider-specific-chat-model" },
              ],
            }
          : {
              data: [
                {
                  model_name: "gpt-4o",
                  litellm_params: { model: "gpt-4o" },
                  model_info: { mode: "chat" },
                },
                {
                  model_name: "text-embedding-3-small",
                  litellm_params: { model: "text-embedding-3-small" },
                  model_info: { mode: "embedding" },
                },
                {
                  model_name: "gpt-image-1",
                  litellm_params: { model: "gpt-image-1" },
                  model_info: { mode: "image_generation" },
                },
                {
                  model_name: "provider-specific-chat-model",
                  litellm_params: { model: "provider-specific-chat-model" },
                  model_info: { mode: "responses" },
                },
              ],
            },
    }) as Response);
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "gateway").models?.["gpt-4o"]).toBeDefined();
    expect(providerFor(config, "gateway").models?.["text-embedding-3-small"]).toBeUndefined();
    expect(providerFor(config, "gateway").models?.["gpt-image-1"]).toBeUndefined();
    expect(providerFor(config, "gateway").models?.["provider-specific-chat-model"]).toBeDefined();
  });

  it.each(["missing", "conflicting", "unavailable"])("excludes image-generation modes from /models when model info is %s", async (infoState) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (input.toString().includes("/models")) {
        return {
          ok: true,
          json: async () => ({ data: [
            { id: "gpt-4o", mode: "chat" },
            { id: "gpt-image-1", mode: "image_generation" },
            { id: "image-route*", mode: "IMAGE_GENERATION" },
          ] }),
        } as Response;
      }
      if (infoState === "unavailable") throw new Error("Model info unavailable");
      return {
        ok: true,
        json: async () => ({ data: infoState === "missing" ? [] : [
          { model_name: "gpt-image-1", litellm_params: { model: "gpt-image-1" }, model_info: { mode: "chat" } },
          { model_name: "image-route*", litellm_params: { model: "image-route*" }, model_info: { mode: "chat" } },
          { model_name: "image-alias*", litellm_params: { model: "gpt-image-1" }, model_info: {} },
        ] }),
      } as Response;
    });
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };
    await applyDiscovery(config);
    expect(Object.keys(providerFor(config, "gateway").models ?? {})).toEqual(["gpt-4o"]);
  });

  it("times out discovery requests and consumes the timeout option", async () => {
    vi.mocked(fetch).mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
    );
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: {
            baseURL: "https://llm.example.com/v1",
            "opencode-model-discovery": {
              discovery: true,
              discoveryTimeout: 1,
            },
          },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "gateway").models).toBeUndefined();
    expect(providerFor(config, "gateway").options).not.toHaveProperty("opencode-model-discovery");
  });

  it("reuses discovery responses until the configured cache duration expires", async () => {
    const storage = createMemoryStorage();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "cached-model" }] }
          : { data: [] },
    }) as Response);

    const config = (): OpenCodeConfig => ({
      provider: {
        gateway: {
          options: {
            baseURL: "https://cache-test.example.com/v1",
            "opencode-model-discovery": { discovery: true, discoveryCache: "PT0.02S" },
          },
        },
      },
    });

    await applyDiscovery(config(), undefined, storage);
    await applyDiscovery(config(), undefined, storage);
    expect(fetch).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await applyDiscovery(config(), undefined, storage);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("ignores logger failures", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await expect(
      applyDiscovery(config, async () => Promise.reject(new Error("logger offline"))),
    ).resolves.toBeUndefined();
  });

  it("uses model_name for wildcard routes missing from /v1/models", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }] }
          : {
              data: [
                {
                  model_name: "claude-opus-4-5*",
                  litellm_params: { model: "vertex_ai/claude-opus-4-5@20251101" },
                  model_info: {
                    key: "internal-deployment-key",
                    max_tokens: 64000,
                    max_output_tokens: 64000,
                    max_input_tokens: 200000,
                    supports_reasoning: true,
                  },
                },
              ],
            },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const models = providerFor(config, "gateway").models ?? {};
    expect(models["vertex_ai/claude-opus-4-5@20251101"]).toBeUndefined();
    expect(models["internal-deployment-key"]).toBeUndefined();
    expect(models["claude-opus-4-5*"]?.limit).toEqual({
      context: 200000,
      input: 200000,
      output: 64000,
    });
    expect(models["gpt-4o"]).toBeDefined();
  });

  it("uses model_name when /v1/models matches an upstream alias and deduplicates routes", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "openai/gpt-4o" }, { id: "public-route" }] }
          : {
              data: [{
                model_name: "public-route",
                litellm_params: { model: "openai/gpt-4o" },
                model_info: { key: "internal-key", supports_function_calling: true },
              }],
            },
    }) as Response);
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const models = providerFor(config, "gateway").models ?? {};
    expect(Object.keys(models)).toEqual(["public-route"]);
    expect(models["public-route"]?.tool_call).toBe(true);
  });

  it("keeps distinct wildcard model_names without requiring unique upstream models", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [] }
          : {
              data: [
                { model_name: "route-a*", litellm_params: { model: "shared-upstream" }, model_info: {} },
                { model_name: "route-b*", litellm_params: { model: "shared-upstream" }, model_info: {} },
                { model_name: "route-c*", litellm_params: {}, model_info: { key: "internal-key" } },
              ],
            },
    }) as Response);
    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    expect(Object.keys(providerFor(config, "gateway").models ?? {})).toEqual([
      "route-a*", "route-b*", "route-c*",
    ]);
  });

  it.each([
    ["gpt-4o", "openai"],
    ["EU-gpt-4o-private", "unknown-provider"],
    ["EU-gpt-4o-private", undefined],
  ])("enhances discovered %s with models.dev data regardless of provider %s", async (modelID, litellmProvider) => {
    const catalog: ModelsDevData = {
      "vendor/gpt-4o": {
        id: "vendor/gpt-4o",
        name: "GPT-4o",
        description: "Test model",
        family: "gpt",
        release_date: "2024-05-13",
        temperature: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    };

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://models.dev/models.json") return Response.json(catalog);
      return {
        ok: true,
        json: async () =>
          url.includes("/models")
            ? { data: [{ id: modelID }] }
            : {
                data: [
                  {
                    model_name: modelID,
                    litellm_params: { model: modelID },
                    model_info: {
                      max_input_tokens: 128000,
                      max_output_tokens: 16384,
                      litellm_provider: litellmProvider,
                    },
                  },
                ],
              },
      } as Response;
    });

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: {
            baseURL: "https://llm.example.com/v1",
            "opencode-model-discovery": {
              discovery: true,
              enhanceFromModelsDev: true,
              modelsDevIgnorePrefixes: ["EU-"],
              modelsDevIgnorePostfixes: ["-private"],
            },
          },
        },
      },
    };

    await applyDiscovery(config);

    const model = providerFor(config, "gateway").models?.[modelID];
    expect(Object.keys(providerFor(config, "gateway").models ?? {})).toEqual([modelID]);
    expect(providerFor(config, "gateway").options?.["opencode-model-discovery"]).toBeUndefined();
    expect(model?.family).toBe("gpt");
    expect(model).not.toHaveProperty("release_date");
    expect(model).not.toHaveProperty("temperature");
    expect(model?.cost).toBeUndefined();
    // LiteLLM-derived limit must remain untouched by the enhancement pass.
    expect(model?.limit).toEqual({ context: 128000, input: 128000, output: 16384 });

    expect(vi.mocked(fetch).mock.calls.some(([url]) => url.toString() === "https://models.dev/models.json"))
      .toBe(true);
  });

  it("does not fetch models.dev when enhanceFromModelsDev is not set", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "gpt-4o" }] }
          : { data: [] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    for (const call of vi.mocked(fetch).mock.calls) {
      expect(call[0]?.toString()).not.toContain("models.dev");
    }
  });

  it("preserves independently reported limits when catalog enrichment completes legacy limits", async () => {
    const entries = [
      { model_name: "output-only", litellm_params: {}, model_info: { max_output_tokens: 1024 } },
      { model_name: "input-only", litellm_params: {}, model_info: { max_input_tokens: "8192" } },
      { model_name: "output-alias", litellm_params: {}, model_info: { max_tokens: "4096" } },
      { model_name: "explicit-output", litellm_params: {}, model_info: { max_tokens: 4096, max_output_tokens: 8192 } },
    ];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://models.dev/models.json") {
        return Response.json(Object.fromEntries(entries.map(({ model_name: id }) => [id, {
          id, name: id, description: "Test model",
          limit: { context: 128000, input: 120000, output: 16384 },
        }])));
      }
      return Response.json({ data: url.includes("/models")
        ? entries.map(({ model_name: id }) => ({ id })) : entries });
    });
    const config: OpenCodeConfig = { provider: { gateway: { options: {
      baseURL: "https://llm.example.com/v1",
      "opencode-model-discovery": { discovery: true, enhanceFromModelsDev: true },
    } } } };

    await applyDiscovery(config);

    const models = providerFor(config, "gateway").models;
    expect(models?.["output-only"].limit).toEqual({ context: 128000, input: 120000, output: 1024 });
    expect(models?.["input-only"].limit).toEqual({ context: 8192, input: 8192, output: 16384 });
    expect(models?.["output-alias"].limit).toEqual({ context: 128000, input: 120000, output: 4096 });
    expect(models?.["explicit-output"].limit).toEqual({ context: 128000, input: 120000, output: 8192 });
  });

  it("enhances discovery from the bundled snapshot when models.dev is unavailable", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://models.dev/models.json") throw new Error("Network unavailable");
      return {
        ok: true,
        json: async () =>
          url.includes("/models")
            ? { data: [{ id: "gpt-4o" }] }
            : { data: [] },
      } as Response;
    });

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: {
            baseURL: "https://llm.example.com/v1",
            "opencode-model-discovery": { discovery: true, enhanceFromModelsDev: true },
          },
        },
      },
    };

    await applyDiscovery(config);

    expect(providerFor(config, "gateway").models?.["gpt-4o"]?.name).toBe("Gpt 4o");
    expect(providerFor(config, "gateway").models?.["gpt-4o"]?.family).toBe("gpt");
    expect(providerFor(config, "gateway").models?.["gpt-4o"]?.cost).toBeUndefined();

  });

  it("preserves a wildcard id from /v1/models", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "claude-opus-4-5*" }] }
          : {
              data: [
                {
                  model_name: "claude-opus-4-5*",
                  litellm_params: { model: "vertex_ai/claude-opus-4-5@20251101" },
                  model_info: { max_tokens: 64000, max_output_tokens: 64000 },
                },
              ],
            },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: { baseURL: "https://llm.example.com/v1", "opencode-model-discovery": { discovery: true } },
        },
      },
    };

    await applyDiscovery(config);

    const models = providerFor(config, "gateway").models ?? {};
    expect(models["claude-opus-4-5*"]).toBeDefined();
    expect(models["vertex_ai/claude-opus-4-5@20251101"]).toBeUndefined();
  });
});

describe("ModelDiscoveryPlugin", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("preserves per-modality flags through discovery, enrichment and defaults (catalog: %s)", async (enhanceFromModelsDev) => {
    const entries = [
      { model_name: "text-only", litellm_params: {}, model_info: {
        supports_vision: false, supports_audio_input: false, supports_pdf_input: false, supports_audio_output: false,
      } },
      { model_name: "non-vision", litellm_params: {}, model_info: { supports_vision: false } },
      { model_name: "vision-only-reported", litellm_params: {}, model_info: { supports_vision: true } },
      { model_name: "mixed", litellm_params: {}, model_info: { supports_vision: false, supports_audio_input: true, supports_audio_output: false } },
      { model_name: "output-only-reported", litellm_params: {}, model_info: { supports_audio_output: true } },
      { model_name: "unreported", litellm_params: {}, model_info: {} },
    ];
    const catalogModalities = { input: ["text", "image", "audio", "pdf"], output: ["text", "audio"] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://models.dev/models.json") {
        return Response.json(Object.fromEntries(entries.map(({ model_name: id }) => [id, {
          id, name: id, description: "Test model", modalities: catalogModalities,
        }])));
      }
      return Response.json({ data: url.includes("/models")
        ? entries.map(({ model_name: id }) => ({ id })) : entries });
    }));
    let transform: Parameters<Context["model"]["transform"]>[0] | undefined;
    const reload = vi.fn().mockResolvedValue(undefined);
    const settings = {
      baseURL: "https://llm.example.com/v1",
      "opencode-model-discovery": { discovery: true, enhanceFromModelsDev },
    };
    const providerRecord = {
      provider: { id: "gateway", name: "Gateway", settings },
      models: new Map(),
    };
    await ModelDiscoveryPlugin({
      provider: { transform: vi.fn() },
      model: { transform: vi.fn(async (cb) => { transform = cb; }), reload },
      storage: createMemoryStorage(),
    } as unknown as Context);
    const updated = new Map<string, Record<string, unknown>>();
    const editor = {
      provider: { list: () => [providerRecord], get: () => providerRecord },
      update: (_providerID: string, id: string, cb: (draft: Record<string, unknown>) => void) => {
        const draft = { id };
        cb(draft);
        updated.set(id, draft);
      },
    };
    transform?.(editor as never);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    transform?.(editor as never);

    const expected = {
      "text-only": { input: ["text"], output: ["text"] },
      "non-vision": { input: enhanceFromModelsDev ? ["text", "audio", "pdf"] : ["text"], output: enhanceFromModelsDev ? ["text", "audio"] : ["text"] },
      "vision-only-reported": enhanceFromModelsDev ? catalogModalities : { input: ["text", "image"], output: ["text"] },
      mixed: { input: enhanceFromModelsDev ? ["text", "audio", "pdf"] : ["text", "audio"], output: ["text"] },
      "output-only-reported": { input: enhanceFromModelsDev ? catalogModalities.input : ["text", "image"], output: ["text", "audio"] },
      unreported: enhanceFromModelsDev ? catalogModalities : { input: ["text", "image"], output: ["text"] },
    };
    for (const [id, modalities] of Object.entries(expected)) {
      expect(updated.get(id)?.capabilities, id).toEqual({ tools: true, ...modalities });
    }

    // The public config-style bridge must also preserve explicit negatives.
    const config: OpenCodeConfig = { provider: { gateway: { options: settings } } };
    await applyDiscovery(config);
    expect(providerFor(config, "gateway").models?.["text-only"]?.modalities).toEqual(expected["text-only"]);
    expect(providerFor(config, "gateway").models?.["text-only"]?.attachment).toBe(false);
    expect(providerFor(config, "gateway").models?.["non-vision"]?.modalities).toEqual(expected["non-vision"]);
  });

  it.each([false, true])("preserves partial LiteLLM limits through runtime defaults (catalog: %s)", async (enhanceFromModelsDev) => {
    const entries = [
      { model_name: "output-only", litellm_params: {}, model_info: { max_output_tokens: "1024" } },
      { model_name: "input-only", litellm_params: {}, model_info: { max_input_tokens: 8192 } },
      { model_name: "zero-output", litellm_params: {}, model_info: { max_output_tokens: 0 } },
      { model_name: "missing-limits", litellm_params: {}, model_info: {} },
      { model_name: "output-alias", litellm_params: {}, model_info: { max_tokens: "4096" } },
      { model_name: "explicit-output", litellm_params: {}, model_info: { max_tokens: 4096, max_output_tokens: 8192 } },
      { model_name: "zero-with-alias", litellm_params: {}, model_info: { max_tokens: 4096, max_output_tokens: 0 } },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://models.dev/models.json") {
        return Response.json(Object.fromEntries(entries.map(({ model_name: id }) => [id, {
          id, name: id, description: "Test model",
          limit: { context: 128000, input: 120000, output: 16384 },
        }])));
      }
      return Response.json({ data: url.includes("/models")
        ? entries.map(({ model_name: id }) => ({ id })) : entries });
    }));
    let transform: Parameters<Context["model"]["transform"]>[0] | undefined;
    const reload = vi.fn().mockResolvedValue(undefined);
    const providerRecord = {
      provider: { id: "gateway", name: "Gateway", settings: {
        baseURL: "https://llm.example.com/v1",
        "opencode-model-discovery": { discovery: true, enhanceFromModelsDev },
      } },
      models: new Map(),
    };
    const ctx = {
      provider: { transform: vi.fn() },
      model: { transform: vi.fn(async (cb) => { transform = cb; }), reload },
      storage: createMemoryStorage(),
    } as unknown as Context;
    await ModelDiscoveryPlugin(ctx);

    const updated = new Map<string, Record<string, unknown>>();
    const editor = {
      provider: { list: () => [providerRecord], get: () => providerRecord },
      update: (_providerID: string, id: string, cb: (draft: Record<string, unknown>) => void) => {
        const draft = { id };
        cb(draft);
        updated.set(id, draft);
      },
    };
    transform?.(editor as never);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    transform?.(editor as never);

    const fallback = enhanceFromModelsDev
      ? { context: 128000, input: 120000, output: 16384 }
      : { context: 200000, output: 32000 };
    expect(updated.get("output-only")?.limit).toEqual({ ...fallback, output: 1024 });
    expect(updated.get("input-only")?.limit).toEqual({ ...fallback, context: 8192, input: 8192 });
    expect(updated.get("zero-output")?.limit).toEqual({ ...fallback, output: 0 });
    expect(updated.get("missing-limits")?.limit).toEqual(fallback);
    expect(updated.get("output-alias")?.limit).toEqual({ ...fallback, output: 4096 });
    expect(updated.get("explicit-output")?.limit).toEqual({ ...fallback, output: 8192 });
    expect(updated.get("zero-with-alias")?.limit).toEqual({ ...fallback, output: 0 });
  });

  it.each([true, false, undefined])("preserves raw overrides while enriching existing runtime models (%s)", async (enrichExistingModels) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === "https://models.dev/models.json") {
        return Response.json({ "lab/model-a": {
          id: "lab/model-a", name: "Model A", description: "Test model",
          family: "gpt", tool_call: true, reasoning: true,
          limit: { context: 128000, output: 16384 },
          modalities: { input: ["text", "image"], output: ["text"] },
        } });
      }
      return Response.json(input.toString().includes("/models")
        ? { data: [{ id: "model-a" }, { id: "new-model" }] }
        : { data: [{ model_name: "model-a", litellm_params: {}, model_info: {
          supported_openai_params: ["max_completion_tokens"],
          input_cost_per_token: 0.000002, output_cost_per_token: 0.000008,
        } }] });
    }));
    let transform: Parameters<Context["model"]["transform"]>[0] | undefined;
    const reload = vi.fn().mockResolvedValue(undefined);
    const providerRecord = {
      provider: { id: "gateway", name: "Gateway", settings: {
        baseURL: "https://llm.example.com/v1",
        "opencode-model-discovery": { discovery: true, enrichExistingModels, enhanceFromModelsDev: true },
      } },
      models: new Map([["model-a", { name: "Custom" }], ["manual-only", { name: "Manual only" }]]),
    };
    const ctx = {
      provider: { transform: vi.fn() },
      model: { transform: vi.fn(async (cb) => { transform = cb; }), reload },
      storage: createMemoryStorage(),
    } as unknown as Context;
    await ModelDiscoveryPlugin(ctx);

    let configured: Record<string, unknown> = { name: "Custom" };
    const updated = new Map<string, Record<string, unknown>>();
    const editor = {
      provider: { list: () => [providerRecord], get: () => providerRecord },
      update: vi.fn((_providerID: string, id: string, cb: (draft: Record<string, unknown>) => void) => {
        const draft = id === "model-a" ? structuredClone(configured) : { id };
        cb(draft);
        updated.set(id, draft);
      }),
    };
    transform?.(editor as never);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    transform?.(editor as never);

    expect(updated.has("manual-only")).toBe(false);
    expect(updated.has("new-model")).toBe(true);
    if (enrichExistingModels !== true) {
      expect(updated.has("model-a")).toBe(false);
      return;
    }
    expect(updated.get("model-a")).toMatchObject({
      name: "Custom", family: "gpt",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 128000, output: 16384 },
      compatibility: { reasoningField: "reasoning_content", maxTokensField: "max_completion_tokens" },
      cost: [{ input: 2, output: 8 }],
    });
    // A replay uses the current raw overrides and must preserve explicit empty/false values.
    configured = {
      name: "", capabilities: { tools: false, input: [] }, limit: { output: 0 },
      compatibility: { maxTokensField: "max_tokens" }, cost: [],
      settings: { custom: null }, enabled: false,
    };
    transform?.(editor as never);
    const expected = {
      ...configured, family: "gpt",
      capabilities: { tools: false, input: [], output: ["text"] },
      limit: { context: 128000, output: 0 },
      compatibility: { maxTokensField: "max_tokens", reasoningField: "reasoning_content" },
    };
    expect(updated.get("model-a")).toEqual(expected);
    transform?.(editor as never);
    expect(updated.get("model-a")).toEqual(expected);
    expect(configured.limit).toEqual({ output: 0 });
    expect(providerRecord.models.get("model-a")).toEqual({ name: "Custom" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("uses ctx.storage and enriches typed runtime models before applying defaults", async () => {
    const storage = createMemoryStorage();
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (input.toString() === "https://models.dev/models.json") {
        return Response.json({ "lab/model-a": {
          id: "lab/model-a", name: "Model A", description: "Test model",
          family: "gpt", tool_call: false, reasoning: true,
          limit: { context: 1000 },
          modalities: { input: ["text", "image"], output: ["text"] },
        } });
      }
      return ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "model-a" }] }
          : { data: [{ model_name: "model-a", litellm_params: {}, model_info: {} }] },
      }) as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    let providerTransformCb: Parameters<Context["provider"]["transform"]>[0] | undefined;
    let modelTransformCb: Parameters<Context["model"]["transform"]>[0] | undefined;
    const reloadMock = vi.fn().mockResolvedValue(undefined);

    const providerRecord = {
      provider: {
        id: "my-provider",
        name: "My Provider",
        settings: {
          baseURL: "https://llm.example.com/v1",
          "opencode-model-discovery": {
            discovery: true,
            discoveryCache: "PT1H",
            enhanceFromModelsDev: true,
          },
        },
      },
      models: new Map(),
    };

    const ctx = {
      provider: {
        transform: vi.fn().mockImplementation(async (cb) => {
          providerTransformCb = cb;
        }),
      },
      model: {
        transform: vi.fn().mockImplementation(async (cb) => {
          modelTransformCb = cb;
        }),
        reload: reloadMock,
      },
      storage,
    } as unknown as Context;

    await ModelDiscoveryPlugin(ctx);

    expect(ctx.provider.transform).toHaveBeenCalled();
    expect(ctx.model.transform).toHaveBeenCalled();

    const providerEditor = {
      list: () => [providerRecord],
      update: vi.fn(),
    };
    providerTransformCb?.(providerEditor as never);

    const updatedModels = new Map<string, unknown>();
    const modelEditor = {
      provider: {
        list: () => [providerRecord],
        get: () => providerRecord,
      },
      update: vi.fn((_pId: string, mId: string, updateFn: (draft: Record<string, unknown>) => void) => {
        const draft = { id: mId };
        updateFn(draft);
        updatedModels.set(mId, draft);
      }),
    };

    modelTransformCb?.(modelEditor as never);

    // Wait for background discovery promise to complete and reload to be called
    await vi.waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });

    // Replay model transform after reload
    modelTransformCb?.(modelEditor);
    expect(updatedModels.has("model-a")).toBe(true);
    expect(updatedModels.get("model-a")).toMatchObject({
      family: "gpt",
      capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
      limit: { context: 1000 },
      compatibility: { reasoningField: "reasoning_content" },
      cost: [],
    });

    // Check that ctx.storage was populated with cache entries
    const cachedEntries = await storage.scan({ prefix: "discovery:" });
    expect(cachedEntries.entries.length).toBeGreaterThan(0);
  });
});
