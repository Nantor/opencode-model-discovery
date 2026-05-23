import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  toDisplayName,
  sanitizeKey,
  mergeProvider,
  loadConfig,
  buildProviderConfig,
  resolveOutputPath,
  fetchModels,
  fetchModelInfo,
  validateConfig,
  getOpenCodeConfigSchema,
  resetSchemaCache,
  createProgram,
  type OpenCodeConfig,
} from "./index.js";

// ---------------------------------------------------------------------------
// toDisplayName
// ---------------------------------------------------------------------------

describe("toDisplayName", () => {
  it("capitalizes first letter of each word separated by hyphens", () => {
    expect(toDisplayName("gpt-4o-mini")).toBe("Gpt 4o Mini");
  });

  it("strips provider prefix before the slash", () => {
    expect(toDisplayName("openai/gpt-4o")).toBe("Gpt 4o");
  });

  it("handles a single word with no hyphens", () => {
    expect(toDisplayName("claude")).toBe("Claude");
  });

  it("handles multiple slash segments, keeping only the last", () => {
    expect(toDisplayName("anthropic/claude-3-haiku")).toBe("Claude 3 Haiku");
  });

  it("handles an id that is already a display name (no hyphens or slashes)", () => {
    expect(toDisplayName("Llama")).toBe("Llama");
  });

  it("falls back to the full id when the segment after the slash is empty", () => {
    expect(toDisplayName("openai/")).toBe("Openai/");
  });
});

// ---------------------------------------------------------------------------
// sanitizeKey
// ---------------------------------------------------------------------------

describe("sanitizeKey", () => {
  it("passes through safe characters unchanged", () => {
    expect(sanitizeKey("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("allows forward slashes (provider/model notation)", () => {
    expect(sanitizeKey("openai/gpt-4o")).toBe("openai/gpt-4o");
  });

  it("allows dots and underscores", () => {
    expect(sanitizeKey("model_v1.2")).toBe("model_v1.2");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeKey("my model")).toBe("my_model");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeKey("model@2024!")).toBe("model_2024_");
  });

  it("replaces colons with underscores", () => {
    expect(sanitizeKey("ns:model-id")).toBe("ns_model-id");
  });
});

// ---------------------------------------------------------------------------
// mergeProvider
// ---------------------------------------------------------------------------

describe("mergeProvider", () => {
  it("adds a new provider to an empty config", () => {
    const config = { $schema: "https://opencode.ai/config.json" };
    const provider = { npm: "@ai-sdk/openai-compatible", models: {} };
    const result = mergeProvider(config, "litellm", provider);
    expect(result.provider).toEqual({ litellm: provider });
    expect(result.$schema).toBe("https://opencode.ai/config.json");
  });

  it("replaces an existing provider by key without touching others", () => {
    const config = {
      provider: {
        existing: { npm: "old-npm", models: {} },
        litellm: { npm: "old", models: {} },
      },
    };
    const newProvider = { npm: "@ai-sdk/openai-compatible", models: { "gpt-4o": { name: "GPT 4o" } } };
    const result = mergeProvider(config, "litellm", newProvider);
    expect(result.provider?.litellm).toEqual(newProvider);
    expect(result.provider?.existing).toEqual({ npm: "old-npm", models: {} });
  });

  it("preserves other top-level config keys", () => {
    const config: OpenCodeConfig = { theme: "dark", keybindings: "vim" };
    const result = mergeProvider(config, "litellm", { models: {} });
    expect(result.theme).toBe("dark");
    expect(result.keybindings).toBe("vim");
  });

  it("handles a config with no provider key", () => {
    const config = {};
    const result = mergeProvider(config, "myprovider", { models: {} });
    expect(result.provider).toHaveProperty("myprovider");
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "litellm-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a default config when the file does not exist", () => {
    const result = loadConfig(join(tmpDir, "nonexistent.json"));
    expect(result).toEqual({ $schema: "https://opencode.ai/config.json" });
  });

  it("parses a valid JSON config file", () => {
    const filePath = join(tmpDir, "opencode.json");
    const data = { $schema: "https://opencode.ai/config.json", provider: {} };
    writeFileSync(filePath, JSON.stringify(data), "utf-8");
    expect(loadConfig(filePath)).toEqual(data);
  });

  it("returns a default config on invalid JSON", () => {
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "not valid json", "utf-8");
    const result = loadConfig(filePath);
    expect(result).toEqual({ $schema: "https://opencode.ai/config.json" });
  });
});

// ---------------------------------------------------------------------------
// buildProviderConfig
// ---------------------------------------------------------------------------

describe("buildProviderConfig", () => {
  const sampleModels = [
    { id: "gpt-4o", object: "model" },
    { id: "openai/gpt-4o-mini", object: "model" },
    { id: "my model!", object: "model" },
  ];

  it("sets the npm adapter to @ai-sdk/openai-compatible", () => {
    const config = buildProviderConfig(sampleModels, "http://localhost:4000");
    expect(config.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("appends /v1 to the base URL and strips trailing slash", () => {
    const config = buildProviderConfig(sampleModels, "http://localhost:4000/");
    expect(config.options?.baseURL).toBe("http://localhost:4000/v1");
  });

  it("includes the API key in options when provided", () => {
    const config = buildProviderConfig(sampleModels, "http://localhost:4000", "sk-secret");
    expect(config.options?.apiKey).toBe("sk-secret");
  });

  it("omits apiKey when not provided", () => {
    const config = buildProviderConfig(sampleModels, "http://localhost:4000");
    expect(config.options).not.toHaveProperty("apiKey");
  });

  it("uses the provided providerName", () => {
    const config = buildProviderConfig(sampleModels, "http://localhost:4000", undefined, "MyProvider");
    expect(config.name).toBe("MyProvider");
  });

  it("defaults providerName to LiteLLM", () => {
    const config = buildProviderConfig(sampleModels, "http://localhost:4000");
    expect(config.name).toBe("LiteLLM");
  });

  it("builds a models map with sanitized keys and display names", () => {
    const config = buildProviderConfig([{ id: "gpt-4o", object: "model" }], "http://localhost:4000");
    expect(config.models).toHaveProperty("gpt-4o");
    expect(config.models?.["gpt-4o"].name).toBe("Gpt 4o");
  });

  it("preserves the original id when key differs from id", () => {
    const config = buildProviderConfig([{ id: "openai/gpt-4o-mini", object: "model" }], "http://localhost:4000");
    // sanitizeKey keeps slashes, so key == id; no explicit id field expected
    expect(config.models?.["openai/gpt-4o-mini"]).toBeDefined();
  });

  it("adds explicit id field when sanitized key differs from original id", () => {
    const config = buildProviderConfig([{ id: "my model!", object: "model" }], "http://localhost:4000");
    const entry = config.models?.["my_model_"];
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("my model!");
  });

  it("populates model details from modelInfoEntries", () => {
    const modelInfoEntries = [
      {
        model_name: "gpt-4o",
        litellm_params: { model: "gpt-4o" },
        model_info: {
          max_tokens: 128000,
          max_input_tokens: 127000,
          max_output_tokens: 100000,
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
          supports_vision: true,
          supports_function_calling: true,
          supports_tool_choice: true,
          mode: "chat",
          litellm_provider: "openai",
        },
      },
    ];
    const config = buildProviderConfig(
      [{ id: "gpt-4o", object: "model" }],
      "http://localhost:4000",
      undefined,
      undefined,
      modelInfoEntries,
    );
    const entry = config.models?.["gpt-4o"];
    // limit: context uses max_input_tokens (preferred over max_tokens), output uses max_output_tokens
    expect(entry?.limit).toEqual({ context: 127000, output: 100000 });
    // cost: input/output per-token costs
    expect(entry?.cost).toEqual({ input: 0.000003, output: 0.000015 });
    // vision → attachment + image in input modalities
    expect(entry?.attachment).toBe(true);
    expect(entry?.modalities?.input).toContain("image");
    // tool_call from supports_function_calling / supports_tool_choice
    expect(entry?.tool_call).toBe(true);
  });

  it("looks up model info by litellm_params.model", () => {
    const modelInfoEntries = [
      {
        model_name: "gpt-4o-proxy",
        litellm_params: { model: "gpt-4o" },
        model_info: {
          max_tokens: 64000,
          max_input_tokens: 63000,
          max_output_tokens: 50000,
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.00001,
        },
      },
    ];
    const config = buildProviderConfig(
      [{ id: "gpt-4o", object: "model" }],
      "http://localhost:4000",
      undefined,
      undefined,
      modelInfoEntries,
    );
    const entry = config.models?.["gpt-4o"];
    // context uses max_input_tokens (preferred), output uses max_output_tokens
    expect(entry?.limit).toEqual({ context: 63000, output: 50000 });
    expect(entry?.cost?.input).toBe(0.000002);
  });

  it("populates reasoning fields from model_info", () => {
    const modelInfoEntries = [
      {
        model_name: "o1-preview",
        litellm_params: { model: "o1-preview" },
        model_info: {
          max_tokens: 32000,
          max_output_tokens: 32000,
          supports_reasoning: true,
          reasoning: true,
        },
      },
    ];
    const config = buildProviderConfig(
      [{ id: "o1-preview", object: "model" }],
      "http://localhost:4000",
      undefined,
      undefined,
      modelInfoEntries,
    );
    const entry = config.models?.["o1-preview"];
    expect(entry?.reasoning).toBe(true);
    // limit: context falls back to max_tokens when max_input_tokens absent
    expect(entry?.limit).toEqual({ context: 32000, output: 32000 });
  });

  it("sets interleaved from merge_reasoning_content_in_choices", () => {
    const modelInfoEntries = [
      {
        model_name: "deepseek-r1",
        litellm_params: { model: "deepseek-r1", merge_reasoning_content_in_choices: true },
        model_info: {
          max_tokens: 64000,
          max_output_tokens: 8192,
          supports_reasoning: true,
        },
      },
    ];
    const config = buildProviderConfig(
      [{ id: "deepseek-r1", object: "model" }],
      "http://localhost:4000",
      undefined,
      undefined,
      modelInfoEntries,
    );
    const entry = config.models?.["deepseek-r1"];
    expect(entry?.interleaved).toEqual({ field: "reasoning_content" });
  });

  it("does not set interleaved when merge_reasoning_content_in_choices is absent", () => {
    const modelInfoEntries = [
      {
        model_name: "gpt-4o",
        litellm_params: { model: "gpt-4o" },
        model_info: {
          max_tokens: 128000,
          max_output_tokens: 4096,
        },
      },
    ];
    const config = buildProviderConfig(
      [{ id: "gpt-4o", object: "model" }],
      "http://localhost:4000",
      undefined,
      undefined,
      modelInfoEntries,
    );
    const entry = config.models?.["gpt-4o"];
    expect(entry?.interleaved).toBeUndefined();
  });

   it("does not overwrite primary model_name entry when litellm_params.model collides", () => {
    // Two entries share the same litellm_params.model value ("gpt-4o").
    // The first entry's model_info must win for key "gpt-4o" because it is
    // already in the map when the second entry's secondary index is attempted.
    const modelInfoEntries = [
      {
        model_name: "gpt-4o",
        litellm_params: { model: "gpt-4o" },
        model_info: {
          max_tokens: 128000,
          max_input_tokens: 127000,
          max_output_tokens: 4096,
          input_cost_per_token: 0.000005,
          output_cost_per_token: 0.000015,
        },
      },
      {
        model_name: "gpt-4o-alias",
        litellm_params: { model: "gpt-4o" },
        model_info: {
          max_tokens: 999,
          max_input_tokens: 998,
          max_output_tokens: 100,
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
        },
      },
    ];
    const config = buildProviderConfig(
      [{ id: "gpt-4o", object: "model" }],
      "http://localhost:4000",
      undefined,
      undefined,
      modelInfoEntries,
    );
    const entry = config.models?.["gpt-4o"];
    // Must use first entry's info (model_name === "gpt-4o"), not the alias's info.
    expect(entry?.limit).toEqual({ context: 127000, output: 4096 });
    expect(entry?.cost?.input).toBe(0.000005);
  });

  it("skips unknown/undefined type fields gracefully", () => {
    const modelInfoEntries = [
      {
        model_name: "test-model",
        litellm_params: { model: "test-model" },
        model_info: {
          max_tokens: 1000,
          max_output_tokens: 500,
          // input_cost_per_token is undefined (not a number) — cost should not be set
          input_cost_per_token: undefined,
          output_cost_per_token: undefined,
        },
      },
    ];
    const config = buildProviderConfig(
      [{ id: "test-model", object: "model" }],
      "http://localhost:4000",
      undefined,
      undefined,
      modelInfoEntries,
    );
    const entry = config.models?.["test-model"];
    // limit is set from max_tokens (fallback) + max_output_tokens
    expect(entry?.limit).toEqual({ context: 1000, output: 500 });
    // cost is not set when input_cost_per_token is not a number
    expect(entry?.cost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveOutputPath
// ---------------------------------------------------------------------------

describe("resolveOutputPath", () => {
  it("returns opencode.json in cwd by default", () => {
    const result = resolveOutputPath({ global: false });
    expect(result).toBe(join(process.cwd(), "opencode.json"));
  });

  it("returns path inside the specified --path directory", () => {
    let tmpDir: string | null = null;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "litellm-resolve-"));
      const result = resolveOutputPath({ global: false, path: tmpDir });
      expect(result).toBe(join(tmpDir, "opencode.json"));
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns path inside ~/.config/opencode/ when --global is set", () => {
    const result = resolveOutputPath({ global: true });
    expect(result).toMatch(/\.config[/\\]opencode[/\\]opencode\.json$/);
  });
});

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
// validateConfig / getOpenCodeConfigSchema
// ---------------------------------------------------------------------------

/**
 * Minimal JSON Schema used in tests as a stand-in for https://opencode.ai/config.json.
 * Covers logLevel enum, provider structure, additionalProperties constraints.
 */
const MOCK_OPENCODE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $ref: "#/$defs/Config",
  $defs: {
    Config: {
      type: "object",
      properties: {
        $schema: { type: "string" },
        logLevel: { $ref: "#/$defs/LogLevel" },
        provider: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/ProviderConfig" },
        },
      },
      additionalProperties: false,
    },
    LogLevel: {
      type: "string",
      enum: ["DEBUG", "INFO", "WARN", "ERROR"],
    },
    ProviderConfig: {
      type: "object",
      properties: {
        npm: { type: "string" },
        name: { type: "string" },
        options: { type: "object" },
        models: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/ModelEntry" },
        },
      },
      additionalProperties: false,
    },
    ModelEntry: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        family: { type: "string" },
        release_date: { type: "string" },
        attachment: { type: "boolean" },
        reasoning: { type: "boolean" },
        temperature: { type: "boolean" },
        tool_call: { type: "boolean" },
        experimental: { type: "boolean" },
        cost: { type: "object" },
        limit: { type: "object" },
        modalities: { type: "object" },
        provider: { type: "object" },
        options: { type: "object" },
        headers: { type: "object" },
        variants: { type: "object" },
      },
      additionalProperties: false,
    },
  },
};

describe("validateConfig", () => {
  beforeEach(() => {
    // Reset the module-level schema cache before each test so that cache state
    // from a previous test never leaks in, regardless of execution order.
    resetSchemaCache();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_OPENCODE_SCHEMA,
    } as Response);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSchemaCache();
  });

  it("accepts a minimal valid config (just $schema)", async () => {
    await expect(validateConfig({ $schema: "https://opencode.ai/config.json" })).resolves.toBeUndefined();
  });

  it("accepts a complete provider block as produced by buildProviderConfig + mergeProvider", async () => {
    const models = [{ id: "gpt-4o", object: "model" }, { id: "my model!", object: "model" }];
    const providerConfig = buildProviderConfig(models, "http://localhost:4000", "sk-test", "MyProvider");
    const merged = mergeProvider({ $schema: "https://opencode.ai/config.json" }, "myprovider", providerConfig);
    await expect(validateConfig(merged)).resolves.toBeUndefined();
  });

  it("accepts an empty object (all fields are optional)", async () => {
    await expect(validateConfig({})).resolves.toBeUndefined();
  });

  it("rejects a config with an unknown top-level key", async () => {
    await expect(validateConfig({ unknownKey: true })).rejects.toThrow(/OpenCode schema/);
  });

  it("rejects a provider whose model entry has an unknown field", async () => {
    const config = {
      provider: {
        myprovider: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-4o": { name: "GPT 4o", bogusField: 123 },
          },
        },
      },
    };
    await expect(validateConfig(config)).rejects.toThrow(/OpenCode schema/);
  });

  it("rejects a provider with an unknown key at the provider level", async () => {
    const config = {
      provider: {
        myprovider: { npm: "@ai-sdk/openai-compatible", badKey: "oops" },
      },
    };
    await expect(validateConfig(config)).rejects.toThrow(/OpenCode schema/);
  });

  it("rejects a non-object value", async () => {
    await expect(validateConfig("not an object")).rejects.toThrow(/OpenCode schema/);
  });

  it("rejects logLevel with an invalid value", async () => {
    await expect(validateConfig({ logLevel: "VERBOSE" })).rejects.toThrow(/OpenCode schema/);
  });

  it("accepts valid logLevel values", async () => {
    for (const level of ["DEBUG", "INFO", "WARN", "ERROR"]) {
      await expect(validateConfig({ logLevel: level })).resolves.toBeUndefined();
    }
  });

  it("getOpenCodeConfigSchema().safeParse returns success:true for valid input", async () => {
    const schema = await getOpenCodeConfigSchema();
    const result = schema.safeParse({ $schema: "https://opencode.ai/config.json" });
    expect(result.success).toBe(true);
  });

  it("getOpenCodeConfigSchema().safeParse returns success:false and error details for invalid input", async () => {
    const schema = await getOpenCodeConfigSchema();
    const result = schema.safeParse({ logLevel: "TRACE" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0].path).toContain("logLevel");
    }
  });
});

// ---------------------------------------------------------------------------
// CLI: --global / --path mutual exclusion
// ---------------------------------------------------------------------------

describe("createProgram: --global/--path mutual exclusion", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error("process.exit called");
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("exits with an error when both --global and --path are supplied", async () => {
    const program = createProgram();
    // exitOverride makes Commander throw instead of calling process.exit for
    // its own validation errors; our guard calls process.exit directly, so
    // we catch the mock throw.
    program.exitOverride();

    await expect(
      program.parseAsync([
        "node",
        "litellm-to-opencode",
        "--base-url",
        "http://localhost:4000",
        "--global",
        "--path",
        "/tmp",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorSpy).toHaveBeenCalledWith("Error: --global and --path are mutually exclusive.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
