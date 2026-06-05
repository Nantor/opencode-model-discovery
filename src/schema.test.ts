import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { validateConfig, getOpenCodeConfigSchema, resetSchemaCache } from "./schema.js";
import { buildProviderConfig } from "./provider.js";
import { mergeProvider } from "./utils.js";

// ---------------------------------------------------------------------------
// Shared mock schema
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

// ---------------------------------------------------------------------------
// validateConfig / getOpenCodeConfigSchema
// ---------------------------------------------------------------------------

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
    const entries = [
      { model_name: "gpt-4o", litellm_params: { model: "gpt-4o" }, model_info: {} },
      { model_name: "my model!", litellm_params: { model: "my model!" }, model_info: {} },
    ];
    const providerConfig = buildProviderConfig(entries, "http://localhost:4000", "sk-test", "MyProvider");
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
// stripExternalRefs behaviour (tested indirectly via validateConfig)
// ---------------------------------------------------------------------------

describe("stripExternalRefs via validateConfig", () => {
  /**
   * Schema with an external-ref-only node (no sibling `type`).
   * Before the fix, stripping the $ref would leave `{}` which JSON Schema
   * treats as "accept anything" — so `{ model: 42 }` would pass even though
   * the field should be a string.  After the fix the node becomes `true`
   * (canonical "accept anything"), which is behaviourally identical for valid
   * inputs but makes the intent explicit and avoids the empty-object ambiguity.
   */
  const SCHEMA_WITH_EXTERNAL_REF_ONLY_NODE = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/$defs/Config",
    $defs: {
      Config: {
        type: "object",
        properties: {
          $schema: { type: "string" },
          // model has ONLY an external $ref — no sibling "type"
          model: { $ref: "https://models.dev/model-schema.json#/$defs/Model" },
          // name has BOTH type and an external $ref (the common pattern)
          name: {
            type: "string",
            $ref: "https://models.dev/model-schema.json#/$defs/Model",
          },
        },
        additionalProperties: false,
      },
    },
  };

  beforeEach(() => {
    resetSchemaCache();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => SCHEMA_WITH_EXTERNAL_REF_ONLY_NODE,
    } as Response);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSchemaCache();
  });

  it("accepts a valid config where model is a string", async () => {
    await expect(
      validateConfig({ model: "anthropic/claude-3-5-sonnet" }),
    ).resolves.toBeUndefined();
  });

  it("accepts a valid config where name is a string", async () => {
    await expect(validateConfig({ name: "My Config" })).resolves.toBeUndefined();
  });

  it("rejects unknown top-level keys even when schema has external-ref-only nodes", async () => {
    await expect(
      validateConfig({ unknownKey: "value" }),
    ).rejects.toThrow(/OpenCode schema/);
  });
});
