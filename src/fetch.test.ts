import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchModelInfo } from "./fetch.js";

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

  it("calls the correct /v1/model/info URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as unknown as Response);

    await fetchModelInfo("http://localhost:4000");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/v1/model/info",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
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
      "http://localhost:4000/v1/model/info",
      expect.any(Object),
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

  it("warns and returns empty array on non-OK HTTP status", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as unknown as Response);

    const result = await fetchModelInfo("http://localhost:4000");
    expect(result).toEqual([]);
  });

  it("warns and returns empty array when data is not an array", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: "not-an-array" }),
    } as unknown as Response);

    const result = await fetchModelInfo("http://localhost:4000");
    expect(result).toEqual([]);
  });
});
