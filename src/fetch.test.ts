import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchModels, fetchModelInfo, testModel } from "./fetch.js";

// ---------------------------------------------------------------------------
// fetchModels
// ---------------------------------------------------------------------------

describe("fetchModels", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the correct /v1/models URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ object: "list", data: [] }),
    } as Response);

    await fetchModels("http://localhost:4000");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/v1/models",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
  });

  it("strips trailing slash from base URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ object: "list", data: [] }),
    } as Response);

    await fetchModels("http://localhost:4000/");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/v1/models",
      expect.any(Object),
    );
  });

  it("includes Authorization header when apiKey is provided", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ object: "list", data: [] }),
    } as Response);

    await fetchModels("http://localhost:4000", "sk-secret");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-secret" }),
      }),
    );
  });

  it("returns the data array from the response", async () => {
    const mockFetch = vi.mocked(fetch);
    const models = [{ id: "gpt-4o", object: "model" }];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ object: "list", data: models }),
    } as Response);

    const result = await fetchModels("http://localhost:4000");
    expect(result).toEqual(models);
  });

  it("throws on non-OK HTTP status", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response);

    await expect(fetchModels("http://localhost:4000")).rejects.toThrow("HTTP 401");
  });

  it("throws when response data is not an array", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ object: "list", data: "not-an-array" }),
    } as Response);

    await expect(fetchModels("http://localhost:4000")).rejects.toThrow('missing "data" array');
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

  it("calls the correct /v1/model/info URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

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
    } as Response);

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
    } as Response);

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
    } as Response);

    const result = await fetchModelInfo("http://localhost:4000");
    expect(result).toEqual(entries);
  });

  it("warns and returns empty array on non-OK HTTP status", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    const result = await fetchModelInfo("http://localhost:4000");
    expect(result).toEqual([]);
  });

  it("warns and returns empty array when data is not an array", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: "not-an-array" }),
    } as Response);

    const result = await fetchModelInfo("http://localhost:4000");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// testModel
// ---------------------------------------------------------------------------

describe("testModel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls POST /v1/chat/completions with correct payload", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "test-1", choices: [{ message: { content: "ok" } }] }),
    } as Response);

    await testModel("http://localhost:4000", "gpt-4o-mini");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "just return hi" }],
        }),
      }),
    );
  });

  it("includes Authorization header when apiKey is provided", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "test-1", choices: [] }),
    } as Response);

    await testModel("http://localhost:4000", "gpt-4o-mini", "sk-test");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("strips trailing slash from base URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "test-1", choices: [] }),
    } as Response);

    await testModel("http://localhost:4000/", "gpt-4o-mini");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/v1/chat/completions",
      expect.any(Object),
    );
  });

  it("returns { ok: true } on successful response", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "test-1", choices: [{ message: { content: "ok" } }] }),
    } as Response);

    const result = await testModel("http://localhost:4000", "gpt-4o-mini");
    expect(result).toEqual({ ok: true });
  });

  it("returns { ok: false, error } on 400 Bad Request", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: { message: "Model not found" } }),
    } as Response);

    const result = await testModel("http://localhost:4000", "nonexistent-model");
    expect(result).toEqual({ ok: false, error: "Model not found" });
  });

  it("returns { ok: false, error } on non-OK status without JSON body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => { throw new Error("not json"); },
    } as Response);

    const result = await testModel("http://localhost:4000", "gpt-4o-mini");
    expect(result).toEqual({ ok: false, error: "HTTP 503 Service Unavailable" });
  });

  it("returns { ok: false, error } on network error", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValue(new Error("ENOTEST"));

    const result = await testModel("http://localhost:4000", "gpt-4o-mini");
    expect(result).toEqual({ ok: false, error: "ENOTEST" });
  });
});
