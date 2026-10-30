import { Model, Provider } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ModelEditor } from "@opencode/plugin/promise/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "./cache.js";
import { ModelDiscoveryPlugin } from "./plugin.js";
import { fillMissingFields } from "./utils.js";

type Draft = Parameters<Parameters<ModelEditor["update"]>[2]>[0];

// Replay the installed host contract: source definitions seed full model drafts;
// config's model transform applies explicit values after plugin model transforms.
async function harness(enrichExistingModels?: boolean): Promise<{
  replay: (before?: object, configured?: object) => Model.Info;
  source: Model.Info;
  cleanup: () => void;
}> {
  const providerID = Provider.ID.make("gateway");
  const id = Model.ID.make("m");
  const source = Model.Info.make({
    ...Model.Info.default(providerID, id), name: "Inherited name",
    family: Model.Family.make("inherited-family"),
    limit: { context: 128000, output: 16384 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    compatibility: { maxTokensField: "max_completion_tokens" },
    cost: [{ input: Model.Cost.fields.input.make(10), output: Model.Cost.fields.output.make(20),
      cache: { read: Model.Cost.fields.input.make(0), write: Model.Cost.fields.input.make(0) } }],
  });
  const record = { provider: {
    ...Provider.Info.empty(providerID), settings: {
      baseURL: "https://gateway.example/v1",
      "opencode-model-discovery": { discovery: true, enrichExistingModels },
    },
  }, models: new Map([[id, source]]) };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ data: url.includes("/models")
    ? [{ id }]
    : [{ model_name: id, litellm_params: {}, model_info: {
      max_input_tokens: 8192, max_output_tokens: 1024,
      input_cost_per_token: 0.000002, output_cost_per_token: 0.000004,
      supports_vision: false, supports_function_calling: false,
      supported_openai_params: ["max_tokens"],
    } }] })));
  let transform: Parameters<Context["model"]["transform"]>[0] | undefined;
  const reload = vi.fn(async () => {});
  const cleanup = await ModelDiscoveryPlugin({
    provider: { transform: vi.fn(async () => ({ dispose: async () => {} })) },
    model: { transform: vi.fn(async (cb) => { transform = cb; }), reload },
    storage: createMemoryStorage(),
  } as unknown as Context);
  const replay = (before: object = {}, configured: object = {}): Model.Info => {
    const draft = fillMissingFields(structuredClone(before), structuredClone(source)) as Draft;
    const editor: ModelEditor = {
      provider: { list: () => [record], get: () => record },
      list: () => [draft], get: () => draft,
      update: (_providerID, _id, cb) => cb(draft),
      remove: () => {}, default: { get: () => undefined, set: () => {} },
    };
    transform?.(editor);
    // Config overlays specified fields; it does not replace the whole model.
    return fillMissingFields(configured, draft) as Model.Info;
  };
  replay();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  return { replay, source, cleanup };
}

describe("V2 source inventory precedence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, false, true])("refreshes inherited catalog/plugin metadata (enrich: %s)", async (enrich) => {
    const h = await harness(enrich);
    const original = structuredClone(h.source);
    const model = h.replay();
    expect(model).toMatchObject({
      name: "M", family: "inherited-family",
      limit: { context: 8192, input: 8192, output: 1024 },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      compatibility: { maxTokensField: "max_tokens" },
      cost: [{ input: 2, output: 4 }],
    });
    expect(h.replay()).toEqual(model);
    expect(h.source).toEqual(original);
    h.cleanup();
  });

  it.each([undefined, false, true])("preserves actual later configured fields, even equal-to-source values (enrich: %s)", async (enrich) => {
    const h = await harness(enrich);
    const configured = { name: "Configured", limit: { output: h.source.limit.output },
      capabilities: { tools: true, input: [] }, compatibility: { maxTokensField: "max_completion_tokens" },
      cost: [], enabled: false, settings: { custom: null } };
    expect(h.replay({}, configured)).toMatchObject({
      ...configured, limit: { context: 8192, input: 8192, output: 16384 },
      capabilities: { tools: true, input: [], output: ["text"] },
    });
    h.cleanup();
  });

  it.each([undefined, false, true])("uses enrichment policy for visible source-relative overrides (enrich: %s)", async (enrich) => {
    const h = await harness(enrich);
    const overrides = { name: "", limit: { output: 0 }, enabled: false,
      capabilities: { input: [] }, cost: [], settings: { custom: null } };
    const model = h.replay(overrides);
    expect(model).toMatchObject(overrides);
    expect(model.limit.context).toBe(enrich ? 8192 : 128000);
    expect(model.capabilities.tools).toBe(!enrich);
    expect(model.compatibility?.maxTokensField).toBe(enrich ? "max_tokens" : "max_completion_tokens");
    expect(h.replay(overrides)).toEqual(model);
    h.cleanup();
  });

  it("treats equal-to-source early values as inherited because provenance is unavailable", async () => {
    const h = await harness(false);
    expect(h.replay({ limit: { output: h.source.limit.output } }).limit.output).toBe(1024);
    h.cleanup();
  });
});
