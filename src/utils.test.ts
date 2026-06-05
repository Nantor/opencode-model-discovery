import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toDisplayName, sanitizeKey, mergeProvider, loadConfig, resolveOutputPath } from "./utils.js";
import type { OpenCodeConfig } from "./types.js";

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

  it("strips trailing slash when the segment after the slash is empty", () => {
    expect(toDisplayName("openai/")).toBe("Openai");
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
