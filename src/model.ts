import { Model, Provider } from "@opencode/plugin";
import { isDeepStrictEqual } from "node:util";
import type { DiscoveredModelInfo, LiteLLMModelInfo, OpenCodeModelCost, OpenCodeModelEntry } from "./types.js";
import { modelModalityDraft } from "./provider.js";

/** Visible overrides only: source definitions carry no user-config provenance. */
export function sourceModelOverrides(model: object, source: object): Record<string, unknown> {
  const sourceFields = source as Record<string, unknown>;
  return Object.fromEntries(Object.entries(model).flatMap(([key, value]) => {
    const inherited = sourceFields[key];
    if (value === undefined || isDeepStrictEqual(value, inherited)) return [];
    if (isRecord(value) && isRecord(inherited)) {
      const nested = sourceModelOverrides(value, inherited);
      return Object.keys(nested).length ? [[key, nested]] : [];
    }
    return [[key, value]];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

/** Convert the legacy public API shape into an OpenCode discovery draft. */
export function modelInfoDraft(entry: OpenCodeModelEntry, info?: LiteLLMModelInfo): DiscoveredModelInfo {
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
  // Legacy modality arrays are complete; metadata preserves which directions were reported.
  const modalities = info ? modelModalityDraft(info) : entry.modalities;
  for (const direction of ["input", "output"] as const) {
    if (modalities?.[direction] !== undefined) {
      model.capabilities = { ...model.capabilities, [direction]: [...modalities[direction]] };
    }
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

/** Materialize a discovery draft for helpers/tests; host callbacks already have defaults. */
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
