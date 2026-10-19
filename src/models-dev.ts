import { Models } from "@opencode-ai/models";
import { Model } from "@opencode/plugin";

import type {
  Logger,
  ModelsDevData,
  ModelsDevModel,
  DiscoveredModelInfo,
  OpenCodeDiscoveryOptions,
} from "./types.js";
import { errorMessage, safeLog } from "./utils.js";

// ---------------------------------------------------------------------------
// models.dev enhancement
// ---------------------------------------------------------------------------
//
// Fills gaps in discovered model metadata (family,
// limits, modalities, ...) using the public models.dev catalog. LiteLLM
// discovery data always wins; models.dev is only used to fill fields that
// LiteLLM's /v2/model/info did not report. Pricing is never copied from the catalog.

function isModelsDevData(value: unknown): value is ModelsDevData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (model) => typeof model === "object" && model !== null && !Array.isArray(model) &&
      typeof (model as Partial<ModelsDevModel>).id === "string" && !("models" in model),
  );
}

/**
 * Fetch provider-independent metadata directly from models.dev/models.json.
 * Enhancement is optional: catalog failures never prevent provider discovery.
 */
export async function getModelsDevData(
  log?: Logger,
): Promise<ModelsDevData | undefined> {
  try {
    const data: unknown = await Models.make().models({ signal: AbortSignal.timeout(10_000) });
    if (!isModelsDevData(data)) throw new Error("Unexpected models.dev catalog format");
    return data;
  } catch (error) {
    await safeLog(
      log,
      "warn",
      `Could not fetch models.dev catalog; falling back to bundled snapshot: ${errorMessage(error)}`,
    );
  }

  try {
    const { models } = await import("@opencode-ai/models/snapshot");
    if (!isModelsDevData(models)) throw new Error("Unexpected models.dev snapshot format");
    return models;
  } catch (error) {
    await safeLog(log, "warn", `Could not load models.dev snapshot: ${errorMessage(error)}`);
    return undefined;
  }
}

function ignoredAffixes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length);
}

/** Find the first canonical catalog model whose ID ends with the affix-cleaned ID. */
export function findModelsDevEntry(
  data: ModelsDevData,
  resolvedID: string,
  options?: Pick<OpenCodeDiscoveryOptions, "modelsDevIgnorePrefixes" | "modelsDevIgnorePostfixes">,
): ModelsDevModel | undefined {
  const prefixes = ignoredAffixes(options?.modelsDevIgnorePrefixes);
  const postfixes = ignoredAffixes(options?.modelsDevIgnorePostfixes);
  let id = resolvedID;
  const prefix = prefixes.find((value) => id.startsWith(value));
  if (prefix) id = id.slice(prefix.length);
  const postfix = postfixes.find((value) => id.endsWith(value));
  if (postfix) id = id.slice(0, -postfix.length);
  if (!id) return undefined;

  return Object.values(data).find((model) => model.id.endsWith(id));
}

/**
 * Fill gaps in a Model.Info-shaped discovery draft using models.dev metadata. Fields
 * already populated from LiteLLM discovery are left untouched; only fields
 * that are still `undefined` are set. Pricing is never read from the catalog.
 * reasoningReported prevents catalog inference when LiteLLM explicitly reports false.
 */
export function enhanceModelInfo(
  modelEntry: DiscoveredModelInfo,
  modelsDevEntry: ModelsDevModel,
  reasoningReported = false,
): void {
  if (modelEntry.family === undefined && typeof modelsDevEntry.family === "string") {
    modelEntry.family = Model.Family.make(modelsDevEntry.family);
  }
  if (!reasoningReported && modelEntry.compatibility?.reasoningField === undefined && modelsDevEntry.reasoning === true) {
    modelEntry.compatibility = { ...modelEntry.compatibility, reasoningField: "reasoning_content" };
  }
  if (modelEntry.capabilities?.tools === undefined && typeof modelsDevEntry.tool_call === "boolean") {
    modelEntry.capabilities = { ...modelEntry.capabilities, tools: modelsDevEntry.tool_call };
  }
  for (const field of ["context", "input", "output"] as const) {
    const value = modelsDevEntry.limit?.[field];
    if (modelEntry.limit?.[field] === undefined && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      modelEntry.limit = { ...modelEntry.limit, [field]: value };
    }
  }
  for (const field of ["input", "output"] as const) {
    const value = modelsDevEntry.modalities?.[field];
    if (modelEntry.capabilities?.[field] === undefined && Array.isArray(value)) {
      modelEntry.capabilities = { ...modelEntry.capabilities, [field]: [...value] };
    }
  }
}
