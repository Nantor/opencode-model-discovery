import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryTimeout } from "../src/fetch.js";

import {
  fetchDiscoveryResponses,
  modelSummaryCSV,
  parseConfigEntries,
  providerSettings,
  selectedProviderConfig,
  runtimeProviderConfig,
} from "./debug-provider.js";

describe("OpenCode V2 provider debugging", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("preserves raw responses and uses normalized URLs, auth, and wildcard queries", async () => {
    const models = { data: [{ id: "model", extra: true }] };
    const info = { data: [{ model_name: "model", extra: true }] };
    const fetchMock = vi.fn(async (url: string) => Response.json(url.includes("/v1/models") ? models : info));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDiscoveryResponses("https://proxy/v1///", "test-key", 2000))
      .resolves.toEqual({ models, modelInfo: info });
    expect(fetchMock).toHaveBeenCalledWith("https://proxy/v1/models?return_wildcard_routes=true", expect.objectContaining({
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      signal: expect.any(AbortSignal),
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://proxy/v2/model/info?return_wildcard_routes=true", expect.anything());
  });

  it("retains the model list when optional detailed info fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/v1/models")
      ? Response.json({ data: [{ id: "model" }] })
      : new Response("Forbidden", { status: 403 })));
    const result = await fetchDiscoveryResponses("https://proxy/v1");
    expect(result.models).toEqual({ data: [{ id: "model" }] });
    expect(result.modelInfoError).toContain("HTTP 403");
    expect(result.modelInfo).toEqual({ error: result.modelInfoError });
  });

  it("reports a mandatory model-list failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
    await expect(fetchDiscoveryResponses("https://proxy/v1")).rejects.toThrow("HTTP 503");
  });

  it.each([undefined, null, -1, NaN, Infinity, "2000"])("uses the default timeout for invalid input %s", async (value) => {
    expect(discoveryTimeout(value)).toBeUndefined();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("Timed out")), { once: true });
    })));
    const result = expect(fetchDiscoveryResponses("https://proxy/v1", undefined, value)).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves zero and fractional timeout values accepted by the plugin", () => {
    expect(discoveryTimeout(0)).toBe(0);
    expect(discoveryTimeout(2.5)).toBe(2.5);
  });

  it("combines resolved provider and model APIs without including other providers", () => {
    const model = { id: "discovered", providerID: "proxy", name: "Discovered", limit: { context: 1000 } };
    const config = runtimeProviderConfig(
      JSON.stringify({ data: { id: "proxy", name: "Proxy", settings: { baseURL: "https://proxy/v1" } } }),
      JSON.stringify({ data: [model, { id: "other", providerID: "other" }] }),
      "proxy",
    );
    expect(config.providers?.proxy.models).toEqual({ discovered: model });
    expect(modelSummaryCSV({ data: [] }, { data: [] }, {}, "proxy", config)).toBe(
      'model,models,model_info,config,config_name_only,runtime\n"discovered",false,false,false,false,true\n',
    );
    expect(() => runtimeProviderConfig('{"data":{"id":"other"}}', '{"data":[]}', "proxy"))
      .toThrow("Invalid runtime provider response");
    expect(() => runtimeProviderConfig('{"data":{"id":"proxy"}}', '{}', "proxy"))
      .toThrow("Invalid runtime model list response");
  });

  it("merges configuration documents in API priority order and ignores directories", () => {
    const { config, paths } = parseConfigEntries(JSON.stringify([
      { type: "directory", path: "/project/.opencode" },
      {
        type: "document",
        path: "/global/opencode.jsonc",
        info: {
          $schema: "https://opencode.ai/config.json",
          providers: {
            litellm: {
              package: "@opencode/ai/providers/openai-compatible",
              settings: {
                baseURL: "https://global.example/v1",
                apiKey: "test-key",
                "opencode-model-discovery": { discovery: true },
              },
              models: { shared: { name: "Shared", limit: { context: 1000, output: 100 } } },
            },
            other: { models: { other: {} } },
          },
        },
      },
      {
        type: "document",
        path: "/project/opencode.jsonc",
        info: {
          providers: {
            litellm: {
              settings: {
                baseURL: "https://project.example/v1",
                "opencode-model-discovery": { discoveryTimeout: 2000 },
              },
              models: { shared: { limit: { output: 200 } }, local: { name: "Local" } },
            },
          },
        },
      },
    ]));

    expect(paths).toEqual(["/global/opencode.jsonc", "/project/opencode.jsonc"]);
    expect(providerSettings("litellm", config)).toEqual({
      baseURL: "https://project.example/v1",
      apiKey: "test-key",
      "opencode-model-discovery": { discovery: true, discoveryTimeout: 2000 },
    });
    expect(config.providers?.litellm.models?.shared).toEqual({
      name: "Shared", limit: { context: 1000, output: 200 },
    });
    expect(selectedProviderConfig(config, "litellm")).toEqual({
      $schema: "https://opencode.ai/config.json",
      providers: { litellm: config.providers?.litellm },
    });
  });

  it("supports inline documents and replaces arrays rather than treating them as maps", () => {
    const { config, paths } = parseConfigEntries(JSON.stringify([
      { type: "document", info: { providers: { proxy: { env: ["OLD_KEY"] } } } },
      { type: "document", info: { providers: { proxy: { env: ["NEW_KEY"] } } } },
    ]));
    expect(paths).toEqual([]);
    expect(config.providers?.proxy.env).toEqual(["NEW_KEY"]);
  });

  it("reports malformed API responses and missing V2 provider settings", () => {
    expect(() => parseConfigEntries("not json")).toThrow("Could not parse opencode api");
    expect(() => parseConfigEntries("{}")).toThrow("Expected configuration entries");
    expect(() => parseConfigEntries('[{"type":"document"}]')).toThrow("Invalid OpenCode");
    expect(() => providerSettings("missing", {})).toThrow("was not found");
    expect(() => providerSettings("proxy", { providers: { proxy: {} } })).toThrow("settings.baseURL");
  });

  it("summarizes V2 configured model IDs and preserves CSV escaping", () => {
    const csv = modelSummaryCSV(
      { data: [{ id: "discovered" }, { id: 'quoted"model' }] },
      { data: [{ model_name: "detailed" }] },
      {
        providers: {
          proxy: {
            models: {
              configured: { name: "Configured" },
              detailed: { name: "Detailed", capabilities: { tools: true } },
            },
          },
        },
      },
      "proxy",
    );
    expect(csv).toBe([
      "model,models,model_info,config,config_name_only",
      '"configured",false,false,true,true',
      '"detailed",false,true,true,false',
      '"discovered",true,false,false,false',
      '"quoted""model",true,false,false,false',
      "",
    ].join("\n"));
  });
});
