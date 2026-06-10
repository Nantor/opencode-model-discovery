import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  toDisplayName,
  sanitizeKey,
  mergeProvider,
  resolveConfigFile,
  loadConfig,
  resolveOutputPath,
  loadDcpConfig,
  parsePercentage,
  resolveDcpConfigFile,
  sortObjectKeys,
  sortByKey,
} from "./utils.js";
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
    const newProvider = {
      npm: "@ai-sdk/openai-compatible",
      models: { "gpt-4o": { name: "GPT 4o" } },
    };
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
// resolveConfigFile
// ---------------------------------------------------------------------------

describe("resolveConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "litellm-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns .json path when neither file exists", () => {
    const result = resolveConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "opencode.json"));
  });

  it("prefers .jsonc when both files exist", () => {
    writeFileSync(join(tmpDir, "opencode.jsonc"), "{}// with comment", "utf-8");
    writeFileSync(join(tmpDir, "opencode.json"), "{}", "utf-8");
    const result = resolveConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "opencode.jsonc"));
  });

  it("returns .json when only .json exists", () => {
    writeFileSync(join(tmpDir, "opencode.json"), "{}", "utf-8");
    const result = resolveConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "opencode.json"));
  });

  it("returns .jsonc when only .jsonc exists", () => {
    writeFileSync(join(tmpDir, "opencode.jsonc"), "{}// with comment", "utf-8");
    const result = resolveConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "opencode.jsonc"));
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

  it("parses a JSONC file with comments", () => {
    const filePath = join(tmpDir, "opencode.jsonc");
    const content = `{
  // this is a comment
  "$schema": "https://opencode.ai/config.json",
  /* block comment */
  "provider": {
    "litellm": {
      "models": {
        "model1": /* intermitten comment */ { // trailing comment test
        },
        "model2": { /* another comment */
        },
        "model3": { "name//": "/* tricky name */" }, // comment after tricky name
      }
    }
  },
}`;
    writeFileSync(filePath, content, "utf-8");
    expect(loadConfig(filePath)).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: {
        litellm: {
          models: {
            model1: {},
            model2: {},
            model3: { "name//": "/* tricky name */" },
          },
        },
      },
    });
  });

  it("parses a JSONC file with trailing commas", () => {
    const filePath = join(tmpDir, "opencode.jsonc");
    const content = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "litellm": {}
  },
}`;
    writeFileSync(filePath, content, "utf-8");
    expect(loadConfig(filePath)).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: { litellm: {} },
    });
  });

  it("returns a default config on invalid JSONC", () => {
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
    expect(result).toMatch(/\.config[/\\]opencode[/\\]opencode\.(json|jsonc)$/);
  });
});

// ---------------------------------------------------------------------------
// loadDcpConfig
// ---------------------------------------------------------------------------

describe("loadDcpConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dcp-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a default DCP config when the file does not exist", () => {
    const result = loadDcpConfig(join(tmpDir, "nonexistent.json"));
    expect(result).toEqual({
      $schema: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    });
  });

  it("parses a valid JSON DCP config file", () => {
    const filePath = join(tmpDir, "dcp.json");
    const data = {
      $schema: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
      compress: {
        minContextLimit: { "litellm/model1": 8000 },
        maxContextLimit: { "litellm/model1": 16000 },
      },
    };
    writeFileSync(filePath, JSON.stringify(data), "utf-8");
    expect(loadDcpConfig(filePath)).toEqual(data);
  });

  it("parses a JSONC file with comments", () => {
    const filePath = join(tmpDir, "dcp.jsonc");
    const content = `{
  // this is a comment
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
  "compress": {
    "minContextLimit": {
      "litellm/model1": 8000 // comment after value
    }
  },
}`;
    writeFileSync(filePath, content, "utf-8");
    expect(loadDcpConfig(filePath)).toEqual({
      $schema: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
      compress: {
        minContextLimit: { "litellm/model1": 8000 },
      },
    });
  });

  it("returns a default DCP config on invalid JSONC", () => {
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "not valid json", "utf-8");
    const result = loadDcpConfig(filePath);
    expect(result).toEqual({
      $schema: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    });
  });
});

// ---------------------------------------------------------------------------
// parsePercentage
// ---------------------------------------------------------------------------

describe("parsePercentage", () => {
  it("parses percentage values with % sign", () => {
    expect(parsePercentage("80%")).toBe(0.8);
    expect(parsePercentage("50%")).toBe(0.5);
    expect(parsePercentage("100%")).toBe(1);
    expect(parsePercentage("0%")).toBe(0);
  });

  it("parses percentage values without % sign", () => {
    expect(parsePercentage("80")).toBe(0.8);
    expect(parsePercentage("50")).toBe(0.5);
    expect(parsePercentage("100")).toBe(1);
    expect(parsePercentage("0")).toBe(0);
  });

  it("handles decimal percentage values", () => {
    expect(parsePercentage("85.5%")).toBe(0.855);
    expect(parsePercentage("92.5")).toBe(0.925);
    expect(parsePercentage("12.34%")).toBe(0.1234);
  });

  it("handles percentage with trailing spaces", () => {
    expect(parsePercentage("80% ")).toBe(0.8);
  });

  it("returns undefined for invalid values", () => {
    expect(parsePercentage("abc")).toBeUndefined();
    expect(parsePercentage("101%")).toBeUndefined();
    expect(parsePercentage("-10%")).toBeUndefined();
    expect(parsePercentage("")).toBeUndefined();
    expect(parsePercentage("%")).toBeUndefined();
    expect(parsePercentage("50.")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveDcpConfigFile
// ---------------------------------------------------------------------------

describe("resolveDcpConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dcp-resolve-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns dcp.json path when neither file exists", () => {
    const result = resolveDcpConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "dcp.json"));
  });

  it("prefers dcp.jsonc when both files exist", () => {
    writeFileSync(join(tmpDir, "dcp.jsonc"), "{}// with comment", "utf-8");
    writeFileSync(join(tmpDir, "dcp.json"), "{}", "utf-8");
    const result = resolveDcpConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "dcp.jsonc"));
  });

  it("returns dcp.json when only dcp.json exists", () => {
    writeFileSync(join(tmpDir, "dcp.json"), "{}", "utf-8");
    const result = resolveDcpConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "dcp.json"));
  });

  it("returns dcp.jsonc when only dcp.jsonc exists", () => {
    writeFileSync(join(tmpDir, "dcp.jsonc"), "{}// with comment", "utf-8");
    const result = resolveDcpConfigFile(tmpDir);
    expect(result).toBe(join(tmpDir, "dcp.jsonc"));
  });
});

// ---------------------------------------------------------------------------
// sortObjectKeys
// ---------------------------------------------------------------------------

describe("sortObjectKeys", () => {
  it("sorts simple object keys alphabetically", () => {
    const input = { z: 1, a: 2, m: 3 };
    const result = sortObjectKeys(input);
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
    expect(result).toEqual({ a: 2, m: 3, z: 1 });
  });

  it("handles empty object", () => {
    const result = sortObjectKeys({});
    expect(Object.keys(result)).toEqual([]);
  });

  it("handles single key object", () => {
    const result = sortObjectKeys({ only: 1 });
    expect(Object.keys(result)).toEqual(["only"]);
  });

  it("sorts keys with numbers using natural order", () => {
    const input = { item10: 1, item2: 2, item1: 3 };
    const result = sortObjectKeys(input);
    expect(Object.keys(result)).toEqual(["item1", "item2", "item10"]);
  });

  it("preserves values while sorting keys", () => {
    const input = { z: { nested: "value" }, a: [1, 2, 3] };
    const result = sortObjectKeys(input);
    expect(Object.keys(result)).toEqual(["a", "z"]);
    expect(result.a).toEqual([1, 2, 3]);
    expect(result.z).toEqual({ nested: "value" });
  });
});

// ---------------------------------------------------------------------------
// sortByKey
// ---------------------------------------------------------------------------

describe("sortByKey", () => {
  it("sorts object by nested string key", () => {
    const input = {
      z: { name: "Zebra" },
      a: { name: "Apple" },
      m: { name: "Monkey" },
    };
    const result = sortByKey(input, "name");
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
  });

  it("handles empty object", () => {
    const result = sortByKey({}, "name");
    expect(Object.keys(result)).toEqual([]);
  });

  it("handles single key object", () => {
    const input = { only: { name: "Only" } };
    const result = sortByKey(input, "name");
    expect(Object.keys(result)).toEqual(["only"]);
  });

  it("sorts numerically when values are numbers", () => {
    const input = {
      z: { value: 10 },
      a: { value: 2 },
      m: { value: 1 },
    };
    const result = sortByKey(input, "value");
    expect(Object.keys(result)).toEqual(["m", "a", "z"]);
  });

  it("uses empty string fallback for missing keys", () => {
    const input = {
      a: { name: "Apple" },
      z: {},
      m: { name: "Monkey" },
    };
    const result = sortByKey(input, "name");
    expect(Object.keys(result)).toEqual(["z", "a", "m"]);
  });

  it("handles mixed types in sort key", () => {
    const input = {
      a: { value: "abc" },
      z: { value: 123 },
      m: { value: "def" },
    };
    const result = sortByKey(input, "value");
    expect(Object.keys(result)).toEqual(["z", "a", "m"]);
  });

  it("preserves full nested objects while sorting", () => {
    const input = {
      z: { name: "Zebra", type: "animal" },
      a: { name: "Apple", type: "fruit" },
    };
    const result = sortByKey(input, "name");
    expect(result.a).toEqual({ name: "Apple", type: "fruit" });
    expect(result.z).toEqual({ name: "Zebra", type: "animal" });
  });
});
