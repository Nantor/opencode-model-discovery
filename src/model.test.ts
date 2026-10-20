import { describe, expect, it } from "vitest";
import { modelInfoDraft, materializeModelInfo } from "./model.js";
import { enhanceModelInfo } from "./models-dev.js";

describe("OpenCode model construction", () => {
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
