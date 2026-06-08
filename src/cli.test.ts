import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProgram } from "./cli.js";
import { resetSchemaCache } from "./schema.js";

// ---------------------------------------------------------------------------
// Shared mock schema (minimal stand-in for https://opencode.ai/config.json)
// ---------------------------------------------------------------------------

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
// CLI: basic run writes config
// ---------------------------------------------------------------------------

describe("createProgram: basic run", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    resetSchemaCache();
    tmpDir = mkdtempSync(join(tmpdir(), "litellm-test-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("opencode.ai")) {
        return { ok: true, json: async () => MOCK_OPENCODE_SCHEMA } as Response;
      }
      // /v1/model/info
      return {
        ok: true,
        json: async () => ({
          data: [{ model_name: "gpt-4o", litellm_params: { model: "gpt-4o" }, model_info: {} }],
        }),
      } as Response;
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    resetSchemaCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes config with model from /v1/model/info", async () => {
    const { readFileSync } = await import("node:fs");
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
    ]);

    const written = JSON.parse(readFileSync(join(tmpDir, "opencode.json"), "utf-8")) as Record<string, unknown>;
    const providers = written["provider"] as Record<string, { models?: Record<string, unknown> }>;
    expect(providers["litellm"]?.models?.["gpt-4o"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CLI: reasoningSummary workaround (always-on)
// ---------------------------------------------------------------------------

describe("createProgram: reasoningSummary workaround", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    resetSchemaCache();
    tmpDir = mkdtempSync(join(tmpdir(), "litellm-test-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("opencode.ai")) {
        return { ok: true, json: async () => MOCK_OPENCODE_SCHEMA } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              model_name: "o1-preview",
              litellm_params: { model: "o1-preview" },
              model_info: { max_tokens: 32000, max_output_tokens: 32000, supports_reasoning: true },
            },
          ],
        }),
      } as Response;
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    resetSchemaCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not write reasoningSummary by default", async () => {
    const { readFileSync } = await import("node:fs");
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
    ]);

    const written = JSON.parse(readFileSync(join(tmpDir, "opencode.json"), "utf-8")) as Record<string, unknown>;
    const providers = written["provider"] as Record<string, { models?: Record<string, { options?: Record<string, unknown> }> }>;
    const model = providers["litellm"]?.models?.["o1-preview"];
    expect(model?.options?.["reasoningSummary"]).toBeUndefined();
  });

  it("writes options.reasoningSummary=null when --reasoning-summary-workaround is enabled", async () => {
    const { readFileSync } = await import("node:fs");
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--reasoning-summary-workaround",
    ]);

    const written = JSON.parse(readFileSync(join(tmpDir, "opencode.json"), "utf-8")) as Record<string, unknown>;
    const providers = written["provider"] as Record<string, { models?: Record<string, { options?: Record<string, unknown> }> }>;
    const model = providers["litellm"]?.models?.["o1-preview"];
    expect(model?.options?.["reasoningSummary"]).toBeNull();
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

// ---------------------------------------------------------------------------
// CLI: --dcp-min / --dcp-max options
// ---------------------------------------------------------------------------

describe("createProgram: --dcp-min / --dcp-max options", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    resetSchemaCache();
    tmpDir = mkdtempSync(join(tmpdir(), "dcp-test-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("opencode.ai")) {
        return { ok: true, json: async () => MOCK_OPENCODE_SCHEMA } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              model_name: "gpt-4o",
              litellm_params: { model: "gpt-4o" },
              model_info: { max_tokens: 128000, max_output_tokens: 4096, max_input_tokens: 128000 },
            },
            {
              model_name: "claude-3-5-sonnet",
              litellm_params: { model: "claude-3-5-sonnet" },
              model_info: { max_tokens: 200000, max_output_tokens: 8192, max_input_tokens: 200000 },
            },
          ],
        }),
      } as Response;
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    resetSchemaCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates dcp.json with min/max context limits when --dcp-min and --dcp-max are set", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-min",
      "80%",
      "--dcp-max",
      "90%",
    ]);

    const dcpPath = join(tmpDir, "dcp.json");
    const dcpConfig = JSON.parse(readFileSync(dcpPath, "utf-8"));

    expect(dcpConfig.$schema).toBe("https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json");
    expect(dcpConfig.compress.modelMinLimits["litellm/gpt-4o"]).toBe(102400);
    expect(dcpConfig.compress.modelMaxLimits["litellm/gpt-4o"]).toBe(115200);
    expect(dcpConfig.compress.modelMinLimits["litellm/claude-3-5-sonnet"]).toBe(160000);
    expect(dcpConfig.compress.modelMaxLimits["litellm/claude-3-5-sonnet"]).toBe(180000);
  });

  it("handles percentage values without % sign", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-min",
      "50",
      "--dcp-max",
      "75",
    ]);

    const dcpPath = join(tmpDir, "dcp.json");
    const dcpConfig = JSON.parse(readFileSync(dcpPath, "utf-8"));

    expect(dcpConfig.compress.modelMinLimits["litellm/gpt-4o"]).toBe(64000);
    expect(dcpConfig.compress.modelMaxLimits["litellm/gpt-4o"]).toBe(96000);
  });

  it("handles decimal percentage values", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-min",
      "85.5%",
      "--dcp-max",
      "92.5",
    ]);

    const dcpPath = join(tmpDir, "dcp.json");
    const dcpConfig = JSON.parse(readFileSync(dcpPath, "utf-8"));

    expect(dcpConfig.compress.modelMinLimits["litellm/gpt-4o"]).toBe(109440);
    expect(dcpConfig.compress.modelMaxLimits["litellm/gpt-4o"]).toBe(118400);
  });

  it("merges with existing DCP config without overwriting other keys", async () => {
    const existingDcp = {
      $schema: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
      compress: {
        modelMinLimits: { "other/provider": 5000 },
        modelMaxLimits: { "other/provider": 10000 },
      },
    };
    writeFileSync(join(tmpDir, "dcp.json"), JSON.stringify(existingDcp), "utf-8");

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-min",
      "80%",
      "--dcp-max",
      "90%",
    ]);

    const dcpPath = join(tmpDir, "dcp.json");
    const dcpConfig = JSON.parse(readFileSync(dcpPath, "utf-8"));

    expect(dcpConfig.compress.modelMinLimits["other/provider"]).toBe(5000);
    expect(dcpConfig.compress.modelMaxLimits["other/provider"]).toBe(10000);
    expect(dcpConfig.compress.modelMinLimits["litellm/gpt-4o"]).toBe(102400);
  });

  it("only sets minContextLimit when only --dcp-min is provided", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-min",
      "80%",
    ]);

    const dcpPath = join(tmpDir, "dcp.json");
    const dcpConfig = JSON.parse(readFileSync(dcpPath, "utf-8"));

    expect(dcpConfig.compress.modelMinLimits["litellm/gpt-4o"]).toBe(102400);
    expect(dcpConfig.compress.modelMaxLimits).toBeUndefined();
  });

  it("only sets maxContextLimit when only --dcp-max is provided", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-max",
      "90%",
    ]);

    const dcpPath = join(tmpDir, "dcp.json");
    const dcpConfig = JSON.parse(readFileSync(dcpPath, "utf-8"));

    expect(dcpConfig.compress.modelMaxLimits["litellm/gpt-4o"]).toBe(115200);
    expect(dcpConfig.compress.modelMinLimits).toBeUndefined();
  });

  it("skips models without context limit", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("opencode.ai")) {
        return { ok: true, json: async () => MOCK_OPENCODE_SCHEMA } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              model_name: "model-without-limits",
              litellm_params: { model: "model-without-limits" },
              model_info: {},
            },
          ],
        }),
      } as Response;
    });

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-min",
      "80%",
      "--dcp-max",
      "90%",
    ]);

    const dcpPath = join(tmpDir, "dcp.json");
    const dcpConfig = JSON.parse(readFileSync(dcpPath, "utf-8"));

    expect(dcpConfig.compress?.minContextLimit?.["litellm/model-without-limits"]).toBeUndefined();
    expect(dcpConfig.compress?.maxContextLimit?.["litellm/model-without-limits"]).toBeUndefined();
  });

  it("works with --dry-run to print DCP config to stdout", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      "node",
      "litellm-to-opencode",
      "--base-url",
      "http://localhost:4000",
      "--path",
      tmpDir,
      "--dcp-min",
      "80%",
      "--dcp-max",
      "90%",
      "--dry-run",
    ]);

    const calls = logSpy.mock.calls.flat();
    const dcpOutput = calls.find((c: string) => typeof c === "string" && c.includes("dcp.json"));

    expect(dcpOutput).toBeDefined();
  });
});
