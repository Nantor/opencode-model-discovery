import { describe, it, expect, vi } from "vitest";

import { buildProviderConfig } from "./provider.js";

// ---------------------------------------------------------------------------
// buildProviderConfig
// ---------------------------------------------------------------------------

describe("buildProviderConfig", () => {
  const sampleEntries = [
    { model_name: "gpt-4o", litellm_params: { model: "gpt-4o" }, model_info: {} },
    { model_name: "openai/gpt-4o-mini", litellm_params: { model: "openai/gpt-4o-mini" }, model_info: {} },
    { model_name: "my model!", litellm_params: { model: "my model!" }, model_info: {} },
  ];

  it("sets the npm adapter to @ai-sdk/openai-compatible", () => {
    const config = buildProviderConfig(sampleEntries, "http://localhost:4000");
    expect(config.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("appends /v1 to the base URL and strips trailing slash", () => {
    const config = buildProviderConfig(sampleEntries, "http://localhost:4000/");
    expect(config.options?.baseURL).toBe("http://localhost:4000/v1");
  });

  it("includes the API key in options when provided", () => {
    const config = buildProviderConfig(sampleEntries, "http://localhost:4000", "sk-secret");
    expect(config.options?.apiKey).toBe("sk-secret");
  });

  it("omits apiKey when not provided", () => {
    const config = buildProviderConfig(sampleEntries, "http://localhost:4000");
    expect(config.options).not.toHaveProperty("apiKey");
  });

  it("uses the provided providerName", () => {
    const config = buildProviderConfig(sampleEntries, "http://localhost:4000", undefined, "MyProvider");
    expect(config.name).toBe("MyProvider");
  });

  it("defaults providerName to LiteLLM", () => {
    const config = buildProviderConfig(sampleEntries, "http://localhost:4000");
    expect(config.name).toBe("LiteLLM");
  });

  it("builds a models map with sanitized keys and display names", () => {
    const config = buildProviderConfig(
      [{ model_name: "gpt-4o", litellm_params: { model: "gpt-4o" }, model_info: {} }],
      "http://localhost:4000",
    );
    expect(config.models).toHaveProperty("gpt-4o");
    expect(config.models?.["gpt-4o"].name).toBe("Gpt 4o");
  });

  it("preserves the original id when key differs from id", () => {
    const config = buildProviderConfig(
      [{ model_name: "openai/gpt-4o-mini", litellm_params: { model: "openai/gpt-4o-mini" }, model_info: {} }],
      "http://localhost:4000",
    );
    // sanitizeKey keeps slashes, so key == id; no explicit id field expected
    expect(config.models?.["openai/gpt-4o-mini"]).toBeDefined();
  });

  it("adds explicit id field when sanitized key differs from original id", () => {
    const config = buildProviderConfig(
      [{ model_name: "my model!", litellm_params: { model: "my model!" }, model_info: {} }],
      "http://localhost:4000",
    );
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
      modelInfoEntries,
      "http://localhost:4000",
    );
    const entry = config.models?.["gpt-4o"];
    // limit: context → max_tokens, input → max_input_tokens, output → max_output_tokens
    expect(entry?.limit).toEqual({ context: 128000, input: 127000, output: 100000 });
    // cost: input/output per-token costs (litellm per-token × 1M → per-million)
    expect(entry?.cost).toEqual({ input: 3, output: 15 });
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
      modelInfoEntries,
      "http://localhost:4000",
    );
    const entry = config.models?.["gpt-4o-proxy"];
    // context → max_tokens, input → max_input_tokens, output → max_output_tokens
    expect(entry?.limit).toEqual({ context: 64000, input: 63000, output: 50000 });
    expect(entry?.cost?.input).toBe(2);
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
      modelInfoEntries,
      "http://localhost:4000",
    );
    const entry = config.models?.["o1-preview"];
    expect(entry?.reasoning).toBe(true);
    // limit: context falls back to max_tokens when max_input_tokens absent; no input field
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
      modelInfoEntries,
      "http://localhost:4000",
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
      modelInfoEntries,
      "http://localhost:4000",
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
      modelInfoEntries,
      "http://localhost:4000",
    );
    const entry = config.models?.["gpt-4o"];
    // Must use first entry's info (model_name === "gpt-4o"), not the alias's info.
    expect(entry?.limit).toEqual({ context: 128000, input: 127000, output: 4096 });
    expect(entry?.cost?.input).toBe(5);
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
      modelInfoEntries,
      "http://localhost:4000",
    );
    const entry = config.models?.["test-model"];
    // limit is set from max_tokens (fallback) + max_output_tokens; no input field
    expect(entry?.limit).toEqual({ context: 1000, output: 500 });
    // cost is not set when input_cost_per_token is not a number
    expect(entry?.cost).toBeUndefined();
  });

  it("warns and overwrites when duplicate model ids produce the same sanitized key", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entries = [
        { model_name: "my-model", litellm_params: { model: "my-model" }, model_info: {} },
        { model_name: "my-model", litellm_params: { model: "my-model" }, model_info: {} },
      ];
      const config = buildProviderConfig(entries, "http://localhost:4000");
      // Only one entry should exist (last one wins)
      expect(Object.keys(config.models ?? {})).toHaveLength(1);
      expect(config.models?.["my-model"]).toBeDefined();
      // A warning must have been emitted for the duplicate
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain("my-model");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // reasoningSummary workaround (always-on)
  // ---------------------------------------------------------------------------

  describe("reasoningSummary workaround", () => {
    const reasoningModelInfoEntries = [
      {
        model_name: "o1-preview",
        litellm_params: { model: "o1-preview" },
        model_info: {
          max_tokens: 32000,
          max_output_tokens: 32000,
          supports_reasoning: true,
        },
      },
      {
        model_name: "gpt-4o",
        litellm_params: { model: "gpt-4o" },
        model_info: {
          max_tokens: 128000,
          max_output_tokens: 4096,
          supports_reasoning: false,
        },
      },
    ];

    it("sets options.reasoningSummary=null on reasoning models", () => {
      const config = buildProviderConfig(reasoningModelInfoEntries, "http://localhost:4000");
      expect(config.models?.["o1-preview"]?.options?.reasoningSummary).toBeNull();
    });

    it("does not set options.reasoningSummary on non-reasoning models", () => {
      const config = buildProviderConfig(reasoningModelInfoEntries, "http://localhost:4000");
      expect(config.models?.["gpt-4o"]?.options).toBeUndefined();
    });
  });

  it("warns when different ids sanitize to the same key", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // "my model" and "my_model" both sanitize to "my_model"
      const entries = [
        { model_name: "my model", litellm_params: { model: "my model" }, model_info: {} },
        { model_name: "my_model", litellm_params: { model: "my_model" }, model_info: {} },
      ];
      const config = buildProviderConfig(entries, "http://localhost:4000");
      expect(Object.keys(config.models ?? {})).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
