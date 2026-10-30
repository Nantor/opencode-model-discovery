import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchModelInfo, fetchModels, isLiteLLMModelInfoEntry } from "./fetch.js";

describe("isLiteLLMModelInfoEntry", () => {
  it.each([
    null,
    [],
    { model_name: 42, litellm_params: {}, model_info: {} },
    { model_name: "bad", litellm_params: [], model_info: {} },
    { model_name: "bad", litellm_params: {}, model_info: [] },
    ...[null, 42, {}, ["chat"]].map((mode) => ({
      model_name: "bad", litellm_params: {}, model_info: { mode },
    })),
    ...[null, 42, {}, "max_completion_tokens", ["max_tokens", {}]].map((supported_openai_params) => ({
      model_name: "bad", litellm_params: {}, model_info: { supported_openai_params },
    })),
    ...[null, 42, {}, ["upstream"]].map((model) => ({
      model_name: "bad", litellm_params: { model }, model_info: {},
    })),
  ])("rejects unusable metadata: %j", (entry) => {
    expect(isLiteLLMModelInfoEntry(entry)).toBe(false);
  });

  it("accepts absent optional fields and valid metadata", () => {
    expect(isLiteLLMModelInfoEntry({ model_name: "basic", litellm_params: {}, model_info: {} })).toBe(true);
    expect(isLiteLLMModelInfoEntry({
      model_name: "chat",
      litellm_params: { model: "upstream" },
      model_info: { mode: "CHAT", supported_openai_params: ["max_tokens", "max_completion_tokens"] },
    })).toBe(true);
  });
});

describe("fetchModels", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes /v1 and filters malformed model entries", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "model-a" }, null, {}, { id: 123 }],
      }),
    } as Response);

    await expect(fetchModels("http://localhost:4000/v1/")).resolves.toEqual([
      { id: "model-a" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/v1/models?return_wildcard_routes=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("throws when the models response has no data array", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(fetchModels("http://localhost:4000")).rejects.toThrow(
      "missing data array",
    );
  });
});

// ---------------------------------------------------------------------------
// fetchModelInfo
// ---------------------------------------------------------------------------

describe("fetchModelInfo", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the correct /v2/model/info URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as unknown as Response);

    await fetchModelInfo("http://localhost:4000");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/v2/model/info?return_wildcard_routes=true",
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("strips trailing slash from base URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as unknown as Response);

    await fetchModelInfo("http://localhost:4000/");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/v2/model/info?return_wildcard_routes=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("includes Authorization header when apiKey is provided", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as unknown as Response);

    await fetchModelInfo("http://localhost:4000", "sk-secret");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-secret" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns the data array from the response", async () => {
    const mockFetch = vi.mocked(fetch);
    const entries = [{ model_name: "gpt-4o", litellm_params: { model: "gpt-4o" }, model_info: { max_tokens: 128000, max_input_tokens: 127000, max_output_tokens: 100000, input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, supports_vision: true, supports_function_calling: true, mode: "chat", litellm_provider: "openai" } }];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: entries }),
    } as unknown as Response);

    const result = await fetchModelInfo("http://localhost:4000");
    expect(result).toEqual(entries);
  });

  it("throws on non-OK HTTP status", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as unknown as Response);

    await expect(fetchModelInfo("http://localhost:4000")).rejects.toThrow(
      "HTTP 500 Internal Server Error",
    );
  });

  it("throws when data is not an array", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: "not-an-array" }),
    } as unknown as Response);

    await expect(fetchModelInfo("http://localhost:4000")).rejects.toThrow(
      "missing data array",
    );
  });
});
