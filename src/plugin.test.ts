import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyDiscovery } from "./plugin.js";
import type { OpenCodeConfig } from "./types.js";

describe("applyDiscovery", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
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
    expect(config.provider?.enabled.models?.["openai/gpt-4o-mini"]?.name).toBe(
      "Gpt 4o Mini",
    );
    expect(config.provider?.disabled.models).toBeUndefined();
    expect(config.provider?.enabled.options).not.toHaveProperty("opencode-model-discovery");
  });

  it("ignores undefined provider entries", async () => {
    const config: OpenCodeConfig = {
      provider: {
        unavailable: undefined as unknown as OpenCodeConfig["provider"][string],
      },
    };

    await expect(applyDiscovery(config)).resolves.toBeUndefined();
  });

  it("formats names with name, id, and provider placeholders", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().includes("/models")
          ? { data: [{ id: "openai/gpt-4o-mini" }] }
          : { data: [] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: {
            baseURL: "https://llm.example.com/v1",
            "opencode-model-discovery": {
              discovery: true,
              modelNameFormat: "{name} | {provider}/{id}",
            },
          },
        },
      },
    };

    await applyDiscovery(config);

    expect(config.provider?.gateway.models?.["openai/gpt-4o-mini"]?.name).toBe(
      "Gpt 4o Mini | gateway/openai/gpt-4o-mini",
    );
    expect(config.provider?.gateway.options).not.toHaveProperty("opencode-model-discovery");
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

    expect(config.provider?.litellm.models?.["gpt-4o"]?.name).toBe("My GPT");
    expect(config.provider?.litellm.models?.["claude-3-5-sonnet"]?.name).toBe(
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

    expect(Object.keys(config.provider?.litellm.models ?? {})).toEqual(["llama3.1:8b"]);
    expect(config.provider?.litellm.models?.["llama3.1:8b"]?.name).toBe("My Llama");
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

    expect(config.provider?.gateway.models?.["model-a"]?.name).toBe("Model A");
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

    expect(config.provider?.gateway.models?.["model-a"]?.name).toBe("Model A");
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

    expect(config.provider?.gateway.models?.["gpt-4o"]?.limit).toEqual({
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

    const transform = config.provider?.gateway.options?.transformRequestBody as
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

    expect(config.provider?.gateway.options).not.toHaveProperty("transformRequestBody");
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

    expect(config.provider?.gateway.models).toBeUndefined();
    expect(config.provider?.gateway.options).not.toHaveProperty("opencode-model-discovery");
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

    const models = config.provider?.gateway.models ?? {};
    expect(models["vertex_ai/claude-opus-4-5@20251101"]).toBeDefined();
    expect(models["claude-opus-4-5*"]).toBeUndefined();
    expect(models["gpt-4o"]).toBeDefined();
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

    const models = config.provider?.gateway.models ?? {};
    expect(models["claude-opus-4-5*"]).toBeDefined();
    expect(models["vertex_ai/claude-opus-4-5@20251101"]).toBeUndefined();
  });
});
