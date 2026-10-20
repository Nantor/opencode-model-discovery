import { Model, Provider } from "@opencode/plugin";
import type { DiscoveredModelInfo, OpenCodeModelCost, OpenCodeModelEntry } from "./types.js";

/** Convert the legacy public API shape into an OpenCode discovery draft. */
export function modelInfoDraft(entry: OpenCodeModelEntry): DiscoveredModelInfo {
  const model: DiscoveredModelInfo = { name: entry.name };
  if (entry.family !== undefined) model.family = Model.Family.make(entry.family);
  if (entry.limit) model.limit = { ...entry.limit };
  if (entry.cost) {
    model.cost = [modelCost(entry.cost)];
    if (entry.cost.context_over_200k) {
      model.cost = [...model.cost, { ...modelCost(entry.cost.context_over_200k), tier: { type: "context", size: 200000 } }];
    }
  }
  if (entry.tool_call !== undefined) model.capabilities = { tools: entry.tool_call };
  if (entry.modalities) {
    model.capabilities = { ...model.capabilities, input: [...entry.modalities.input], output: [...entry.modalities.output] };
  }
  if (entry.reasoning === true || entry.interleaved) {
    model.compatibility = { reasoningField: "reasoning_content" };
  }
  return model;
}

function modelCost(cost: OpenCodeModelCost): Model.Cost {
  const money = Model.Cost.fields.input.make;
  return {
    input: money(cost.input),
    output: money(cost.output),
    cache: { read: money(cost.cache_read ?? 0), write: money(cost.cache_write ?? 0) },
  };
}

/** Apply runtime defaults only after discovery and catalog enrichment. */
export function materializeModelInfo(providerID: string, id: string, draft: DiscoveredModelInfo): Model.Info {
  const defaults = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id));
  return {
    ...defaults,
    ...draft,
    name: draft.name ?? id,
    capabilities: { ...defaults.capabilities, ...draft.capabilities },
    limit: { ...defaults.limit, ...draft.limit },
  };
}

/** Keep applyDiscovery's exported config-style interface compatible. */
export function applyModelInfoDraft(entry: OpenCodeModelEntry, draft: DiscoveredModelInfo): void {
  if (draft.family !== undefined) entry.family = draft.family;
  if (draft.capabilities?.tools !== undefined) entry.tool_call = draft.capabilities.tools;
  if (draft.capabilities?.input && draft.capabilities.output) {
    // The discovery draft's modality arrays originate from the typed catalog or LiteLLM mapping.
    const modalities = ["text", "audio", "image", "video", "pdf"] as const;
    entry.modalities = {
      input: modalities.filter((value) => draft.capabilities?.input?.includes(value)),
      output: modalities.filter((value) => draft.capabilities?.output?.includes(value)),
    };
  }
  if (draft.compatibility?.reasoningField) entry.reasoning = true;
  if (draft.limit?.context !== undefined && draft.limit.output !== undefined) {
    entry.limit = { context: draft.limit.context, output: draft.limit.output, ...(draft.limit.input !== undefined ? { input: draft.limit.input } : {}) };
  }
}
