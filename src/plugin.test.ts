import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelsDevData } from "./types.js";

import { createMemoryStorage } from "./cache.js";
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
                  model_info: { max_tokens: 128000, max_output_tokens: 4096 },
                },
                {
                  model_name: "alias",
                  litellm_params: { model: "gpt-4o" },
                  model_info: { max_tokens: 999, max_output_tokens: 100 },
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

  it("falls back to the resolved model id for wildcard routes missing from /v1/models", async () => {
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
    expect(models["vertex_ai/claude-opus-4-5@20251101"]).toBeDefined();
    expect(models["claude-opus-4-5*"]).toBeUndefined();
    expect(models["gpt-4o"]).toBeDefined();
  });

  it("enhances discovered models with models.dev data when enabled", async () => {
    // The plugin reads OpenCode's local models.dev catalog snapshot rather
    // than fetching models.dev at runtime.
    const cacheDirectory = join(tmpdir(), `opencode-models-${process.pid}-${Date.now()}`);
    process.env.XDG_CACHE_HOME = cacheDirectory;
    const catalog: ModelsDevData = {
      openai: {
        id: "openai",
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            family: "gpt",
            release_date: "2024-05-13",
            temperature: true,
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
    };
    await mkdir(join(cacheDirectory, "opencode"), { recursive: true });
    await writeFile(join(cacheDirectory, "opencode", "models.json"), JSON.stringify(catalog));

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      return {
        ok: true,
        json: async () =>
          url.includes("/models")
            ? { data: [{ id: "gpt-4o" }] }
            : {
                data: [
                  {
                    model_name: "gpt-4o",
                    litellm_params: { model: "gpt-4o" },
                    model_info: {
                      max_tokens: 128000,
                      max_output_tokens: 16384,
                      litellm_provider: "openai",
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
            "opencode-model-discovery": { discovery: true, enhanceFromModelsDev: true },
          },
        },
      },
    };

    await applyDiscovery(config);

    const model = providerFor(config, "gateway").models?.["gpt-4o"];
    expect(model?.family).toBe("gpt");
    expect(model?.release_date).toBe("2024-05-13");
    expect(model?.temperature).toBe(true);
    // LiteLLM-derived limit must remain untouched by the enhancement pass.
    expect(model?.limit).toEqual({ context: 128000, output: 16384 });

    delete process.env.XDG_CACHE_HOME;
    await rm(cacheDirectory, { recursive: true, force: true });
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

  it("continues discovery when models.dev enhancement fails", async () => {
    // A corrupt/invalid local catalog makes the enhancement pass fail, but
    // discovery itself must still complete normally.
    const cacheDirectory = join(tmpdir(), `opencode-models-${process.pid}-${Date.now()}`);
    process.env.XDG_CACHE_HOME = cacheDirectory;
    await mkdir(join(cacheDirectory, "opencode"), { recursive: true });
    await writeFile(join(cacheDirectory, "opencode", "models.json"), "{ not valid json");

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
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

    delete process.env.XDG_CACHE_HOME;
    await rm(cacheDirectory, { recursive: true, force: true });
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
  it("uses ctx.storage for caching during discovery", async () => {
    const storage = createMemoryStorage();
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "model-a" }] }
          : { data: [{ model_name: "model-a", litellm_params: {}, model_info: {} }] },
    }) as Response);
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

    // Check that ctx.storage was populated with cache entries
    const cachedEntries = await storage.scan({ prefix: "discovery:" });
    expect(cachedEntries.entries.length).toBeGreaterThan(0);
  });
});
