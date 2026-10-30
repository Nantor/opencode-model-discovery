import { Model, Provider } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ModelEditor } from "@opencode/plugin/promise/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "./cache.js";
import { ModelDiscoveryPlugin } from "./plugin.js";
import { fillMissingFields } from "./utils.js";

type Transform = Parameters<Context["model"]["transform"]>[0];
type ProviderTransform = Parameters<Context["provider"]["transform"]>[0];
type Draft = Parameters<Parameters<ModelEditor["update"]>[2]>[0];

describe("V2 composed model transforms for new inventory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, false, true])("replaces host defaults while preserving visible earlier edits and later config (enrich: %s)", async (enrichExistingModels) => {
    const providerID = Provider.ID.make("gateway");
    const source = {
      provider: { ...Provider.Info.empty(providerID), settings: {
        baseURL: "https://gateway.example/v1",
        "opencode-model-discovery": { discovery: true, enrichExistingModels },
      } },
      models: new Map<string, Model.Info>(),
    };
    const metadata = { max_input_tokens: 8192, max_output_tokens: 1024,
      supports_vision: false, supports_function_calling: false, supports_reasoning: true,
      supported_openai_params: ["max_tokens"],
      input_cost_per_token: 0.000002, output_cost_per_token: 0.000004 };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ data: url.includes("/models")
      ? ["m", "detailed", "untouched", "fresh-model", "partial", "equal-defaults"].map((id) => ({ id }))
      : ["detailed", "fresh-model", "equal-defaults"].map((model_name) => ({ model_name, litellm_params: {}, model_info: metadata }))
        .concat([{ model_name: "partial", litellm_params: {}, model_info: { max_output_tokens: 512 } }]) })));

    const policy = {
      enabled: false, name: "Policy name", limit: { output: 123 },
      capabilities: { tools: false, input: [] }, cost: [{ input: 7, output: 9, cache: { read: 0, write: 0 } }],
      compatibility: { maxTokensField: "max_completion_tokens" },
      settings: { generation: { temperature: 0 }, custom: { disabled: false, nullable: null, list: [] } },
    };
    const originalPolicy = structuredClone(policy);
    const modelTransforms: Transform[] = [];
    const providerTransforms = new Set<ProviderTransform>();
    let raw = new Map<string, Draft>();
    const replay = (): Map<string, Model.Info> => {
      const record = structuredClone(source);
      for (const transform of [...providerTransforms]) {
        transform({ list: () => [record], get: () => record,
          update: (_id, cb) => cb(record.provider),
        } as Parameters<ProviderTransform>[0]);
      }
      raw = new Map();
      const editor: ModelEditor = {
        provider: { list: () => [record], get: () => record },
        list: () => [...raw.values()], get: (_providerID, id) => raw.get(id),
        update: (pID, id, cb) => {
          if (pID !== providerID) return;
          // Actual V2.2.3 initializes defaults BEFORE the callback.
          const draft = raw.get(id) ?? structuredClone(Model.Info.default(providerID, Model.ID.make(id)));
          cb(draft);
          raw.set(id, draft);
        },
        remove: (_providerID, id) => { raw.delete(id); },
        default: { get: () => undefined, set: () => {} },
      };
      modelTransforms.forEach((transform) => transform(editor));
      return new Map(raw);
    };
    const reload = vi.fn(async () => { replay(); });
    const ctx = {
      provider: { transform: async (cb: ProviderTransform) => {
        providerTransforms.add(cb);
        return { dispose: async () => { providerTransforms.delete(cb); } };
      } },
      model: { transform: async (cb: Transform) => { modelTransforms.push(cb); }, reload },
      storage: createMemoryStorage(),
    } as unknown as Context;
    const earlier = vi.fn<Transform>((editor) => {
      for (const id of ["m", "detailed"]) {
        editor.update(providerID, id, (draft) => Object.assign(draft, structuredClone(policy)));
      }
      editor.update(providerID, "equal-defaults", (draft) => {
        draft.limit.output = 32000;
        draft.capabilities.tools = true;
        draft.cost = [];
      });
    });
    await ctx.model.transform(earlier);
    const cleanup = await ModelDiscoveryPlugin(ctx);
    let configured: object = {};
    const later = vi.fn<Transform>((editor) => {
      editor.update(providerID, "detailed", (draft) => {
        Object.assign(draft, fillMissingFields(structuredClone(configured), draft));
      });
    });
    await ctx.model.transform(later);
    try {
      replay();
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      const models = replay();
      expect(models.get("m")).toMatchObject({ ...policy, limit: { context: 200000, output: 123 } });
      expect(raw.get("detailed")).toMatchObject({
        ...policy, limit: { context: 8192, input: 8192, output: 123 },
        compatibility: { maxTokensField: "max_completion_tokens", reasoningField: "reasoning_content" },
      });
      expect(raw.get("untouched")).toMatchObject({ name: "Untouched" });
      expect(models.get("untouched")).toMatchObject({
        enabled: true, limit: { context: 200000, output: 32000 },
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      });
      for (const id of ["fresh-model", "equal-defaults"]) {
        expect(models.get(id)).toMatchObject({
          name: id === "fresh-model" ? "Fresh Model" : "Equal Defaults",
          limit: { context: 8192, input: 8192, output: 1024 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          cost: [{ input: 2, output: 4 }],
          compatibility: { maxTokensField: "max_tokens" },
        });
      }
      // Unreported fields retain host defaults, independently of reported limits.
      expect(models.get("partial")).toMatchObject({
        limit: { context: 200000, output: 512 },
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, cost: [],
      });
      expect(models.get("partial")?.limit.input).toBeUndefined();
      expect(replay()).toEqual(models);

      // Config's later transform still has final precedence over policy/discovery.
      configured = { name: "Configured", enabled: true, limit: { output: 0 },
        compatibility: { maxTokensField: "max_tokens" },
        settings: { custom: { nullable: "configured" } } };
      expect(replay().get("detailed")).toMatchObject({
        ...configured, limit: { context: 8192, input: 8192, output: 0 },
        compatibility: { maxTokensField: "max_tokens", reasoningField: "reasoning_content" },
        settings: { generation: { temperature: 0 }, custom: { disabled: false, nullable: "configured", list: [] } },
      });
      expect(earlier).toHaveBeenCalledTimes(5);
      expect(later).toHaveBeenCalledTimes(5);
      expect(policy).toEqual(originalPolicy);
      expect(source.models.size).toBe(0);
    } finally {
      cleanup();
    }
  });
});
