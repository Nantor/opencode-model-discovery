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
          url.endsWith("/models")
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
          options: { baseURL: "http://localhost:4000/v1", discovery: true },
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
    expect(config.provider?.enabled.options).not.toHaveProperty("discovery");
  });

  it("formats names with name, id, and provider placeholders", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().endsWith("/models")
          ? { data: [{ id: "openai/gpt-4o-mini" }] }
          : { data: [] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        gateway: {
          options: {
            baseURL: "https://llm.example.com/v1",
            discovery: true,
            modelNameFormat: "{name} | {provider}/{id}",
          },
        },
      },
    };

    await applyDiscovery(config);

    expect(config.provider?.gateway.models?.["openai/gpt-4o-mini"]?.name).toBe(
      "Gpt 4o Mini | gateway/openai/gpt-4o-mini",
    );
    expect(config.provider?.gateway.options).not.toHaveProperty("modelNameFormat");
  });

  it("keeps manually configured models over discovered values", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        input.toString().endsWith("/models")
          ? { data: [{ id: "gpt-4o" }, { id: "claude-3-5-sonnet" }] }
          : { data: [] },
    }) as Response);

    const config: OpenCodeConfig = {
      provider: {
        litellm: {
          options: { baseURL: "http://localhost:4000", discovery: true },
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

  it("keeps basic discovery when detailed model info fails", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith("/model/info")) {
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
          options: { baseURL: "https://llm.example.com/v1", discovery: true },
        },
      },
    };

    await applyDiscovery(config);

    expect(config.provider?.gateway.models?.["model-a"]?.name).toBe("Model A");
  });
});
