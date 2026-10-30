import { ai } from "@opencode/ai";
import { LanguageModel, LLMRequest } from "@opencode/ai/effect";
import { OpenAICompatible } from "@opencode/ai/providers/openai-compatible";
import { fromRequest } from "@opencode/ai/protocols/openai-chat";
import type { Context } from "@opencode/plugin/promise/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryStorage } from "./cache.js";
import { ModelDiscoveryPlugin } from "./plugin.js";
import type { DiscoveredModelInfo } from "./types.js";

type MaxTokensField = "max_tokens" | "max_completion_tokens";

// Exercise the installed V2 provider and encoder, without the legacy request transform.
async function encode(
  id: string,
  compatibility: DiscoveredModelInfo["compatibility"],
  baseURL = "https://gateway.example/v1",
): Promise<Record<string, unknown>> {
  const model = OpenAICompatible.configure({ provider: "gateway", baseURL }).model(id);
  const request = new LLMRequest({
    model: LanguageModel.update(model, { compatibility }),
    system: [], messages: [], tools: [], generation: { maxTokens: 1000 },
  });
  const body = await ai.run(fromRequest(request));
  // Check the actual JSON fields, including absence of the alternative parameter.
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

async function expectTokenField(id: string, draft: DiscoveredModelInfo, field: MaxTokensField): Promise<void> {
  const body = await encode(id, draft.compatibility);
  expect(body.model).toBe(id);
  expect(body[field]).toBe(1000);
  expect(body).not.toHaveProperty(field === "max_tokens" ? "max_completion_tokens" : "max_tokens");
}

describe("V2 discovery token parameter encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, false, true])("honors metadata and explicit overrides (enrichExistingModels: %s)", async (enrichExistingModels) => {
    const cases: { id: string; params?: string[]; field?: MaxTokensField }[] = [
      { id: "legacy", params: ["max_tokens"], field: "max_tokens" },
      { id: "modern", params: ["max_completion_tokens"], field: "max_completion_tokens" },
      { id: "both", params: ["max_tokens", "max_completion_tokens"], field: "max_completion_tokens" },
      { id: "both-reversed", params: ["max_completion_tokens", "max_tokens"], field: "max_completion_tokens" },
      { id: "neither", params: ["temperature"] },
      { id: "empty", params: [] },
      { id: "missing" },
    ];
    const configured = new Map<string, DiscoveredModelInfo>();
    const entries = cases.map(({ id: model_name, params }) => ({
      model_name, litellm_params: {}, model_info: { supported_openai_params: params },
    }));
    for (const { id, params } of cases.slice(0, 4)) {
      const model_name = `override-${id}`;
      configured.set(model_name, { compatibility: {
        maxTokensField: id === "legacy" ? "max_completion_tokens" : "max_tokens",
        reasoningField: "custom_reasoning",
      } });
      entries.push({ model_name, litellm_params: {}, model_info: { supported_openai_params: params } });
    }
    // Enrichment must fill a missing token field without replacing sibling overrides.
    configured.set("name-only", { name: "Custom", compatibility: { reasoningField: "custom_reasoning" } });
    entries.push({ model_name: "name-only", litellm_params: {}, model_info: { supported_openai_params: ["max_tokens"] } });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const data = input.toString().includes("/models")
        ? entries.map(({ model_name: id }) => ({ id })) : entries;
      return Response.json({ data });
    }));
    const record = {
      provider: { id: "gateway", name: "Gateway", settings: {
        baseURL: "https://gateway.example/v1",
        "opencode-model-discovery": { discovery: true, enrichExistingModels },
      } },
      models: configured,
    };
    let transform: Parameters<Context["model"]["transform"]>[0] | undefined;
    const reload = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      provider: { transform: vi.fn() },
      model: { transform: vi.fn(async (cb) => { transform = cb; }), reload },
      storage: createMemoryStorage(),
    } as unknown as Context;
    await ModelDiscoveryPlugin(ctx);
    const drafts = new Map(configured);
    const editor = {
      provider: { list: () => [record], get: () => record },
      update: (_providerID: string, id: string, cb: (draft: DiscoveredModelInfo) => void) => {
        const draft = structuredClone(configured.get(id) ?? {});
        cb(draft);
        drafts.set(id, draft);
      },
    };
    transform?.(editor as never);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    transform?.(editor as never);

    for (const { id, field } of cases) {
      const draft = drafts.get(id)!;
      expect(draft, id).toBeDefined();
      expect(draft.compatibility?.maxTokensField, id).toBe(field);
      await expectTokenField(id, draft, field ?? "max_completion_tokens");
      if (!field) {
        // Unreported parameters must also retain the encoder's endpoint detection.
        const body = await encode(id, draft.compatibility, "https://api.deepseek.com/v1");
        expect(body.max_tokens).toBe(1000);
        expect(body).not.toHaveProperty("max_completion_tokens");
      }
    }
    for (const [id, original] of configured) {
      const draft = drafts.get(id)!;
      const expected = original.compatibility?.maxTokensField
        ?? (enrichExistingModels ? "max_tokens" : undefined);
      expect(draft.compatibility).toEqual({
        reasoningField: "custom_reasoning", ...(expected ? { maxTokensField: expected } : {}),
      });
      await expectTokenField(id, draft, expected ?? "max_completion_tokens");
    }
    expect(configured.get("name-only")).toEqual({
      name: "Custom", compatibility: { reasoningField: "custom_reasoning" },
    });
  });
});
