import { describe, expect, it } from "vitest";
import { modelInfoDraft, materializeModelInfo } from "./model.js";
import { enhanceModelInfo } from "./models-dev.js";
import { buildProviderConfig } from "./provider.js";

describe("OpenCode model construction", () => {
  it("keeps reported positives and negatives when the catalog omits those capabilities", () => {
    const info = { supports_vision: true, supports_audio_input: false, supports_audio_output: true };
    const entry = buildProviderConfig([
      { model_name: "model", litellm_params: {}, model_info: info },
    ], "https://gateway.example").models!.model;
    const draft = modelInfoDraft(entry, info);
    enhanceModelInfo(draft, {
      id: "lab/model", name: "Model", description: "Test",
      modalities: { input: ["text", "audio", "video"], output: ["text"] },
    }, false, info);
    const model = materializeModelInfo("gateway", "model", draft);
    expect(model.capabilities).toEqual({ tools: true, input: ["text", "video", "image"], output: ["text", "audio"] });
  });

  it("keeps non-vision input text-only even when a matching catalog has no modalities", () => {
    const info = { supports_vision: false };
    const draft = modelInfoDraft({}, info);
    enhanceModelInfo(draft, { id: "lab/model", name: "Model", description: "Test" }, false, info);
    expect(materializeModelInfo("gateway", "model", draft).capabilities.input).toEqual(["text"]);
  });

  it("maps discovery pricing to branded runtime costs and preserves context tiers", () => {
    const draft = modelInfoDraft({
      cost: {
        input: 2, output: 8, cache_read: 1,
        context_over_200k: { input: 4, output: 16, cache_write: 5 },
      },
    });
    const model = materializeModelInfo("gateway", "model", draft);
    expect(model.cost).toEqual([
      { input: 2, output: 8, cache: { read: 1, write: 0 } },
      { input: 4, output: 16, cache: { read: 0, write: 5 }, tier: { type: "context", size: 200000 } },
    ]);
    expect(model.id).toBe("model");
    expect(model.providerID).toBe("gateway");
  });

  it("enriches missing capabilities before applying OpenCode defaults", () => {
    const draft = modelInfoDraft({});
    enhanceModelInfo(draft, {
      id: "lab/model", name: "Model", description: "Test model",
      tool_call: false, reasoning: true,
      limit: { context: 1000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    });
    const model = materializeModelInfo("gateway", "model", draft);
    expect(model.capabilities).toEqual({ tools: false, input: ["text", "image"], output: ["text"] });
    expect(model.limit.context).toBe(1000);
    expect(model.compatibility?.reasoningField).toBe("reasoning_content");
    expect(model.cost).toEqual([]);
  });

  it("does not infer reasoning compatibility when LiteLLM explicitly reports no reasoning", () => {
    const draft = modelInfoDraft({});
    enhanceModelInfo(draft, { id: "lab/model", name: "Model", description: "Test", reasoning: true }, true);
    expect(draft.compatibility).toBeUndefined();
  });
});
