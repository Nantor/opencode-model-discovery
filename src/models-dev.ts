import { Models } from "@opencode-ai/models";
import { Model } from "@opencode/plugin";

import { loadModelsDevSnapshot } from "./models-dev-snapshot.js";
import type {
  Logger,
  ModelsDevData,
  ModelsDevModel,
  DiscoveredModelInfo,
  OpenCodeDiscoveryOptions,
} from "./types.js";
import { errorMessage, isModelsDevData, safeLog } from "./utils.ts";

// ---------------------------------------------------------------------------
// models.dev enhancement
// ---------------------------------------------------------------------------
//
// Fills gaps in discovered model metadata (family,
// limits, modalities, ...) using the public models.dev catalog. LiteLLM
// discovery data always wins; models.dev is only used to fill fields that
// LiteLLM's /v2/model/info did not report. Pricing is never copied from the catalog.

/**
 * Whether the buffered `@opencode-ai/models/snapshot` fallback should be
 * bundled. `BUILD_SNAPSHOT` is a compile-time flag injected by esbuild
 * (`--define`) and vitest (`define`): `true` for the fallback build and
 * tests, `false` for the slim build. A bare identifier reference lets both
 * bundler and test runner substitute the literal, so the slim build prunes
 * the dead branch (and its inlined snapshot) while tests keep the fallback.
 */
declare const BUILD_SNAPSHOT: boolean;

/**
 * Fetch provider-independent metadata directly from models.dev/models.json.
 * Enhancement is optional: catalog failures never prevent provider discovery.
 * When the network catalog is unavailable, the bundled snapshot is used as a
 * fallback in the fallback build; in the slim build this returns `undefined`.
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

  if (BUILD_SNAPSHOT) {
    return loadModelsDevSnapshot(log);
  }
  await safeLog(log, "warn", "Could not fetch models.dev catalog; slim build has no bundled snapshot to fall back to");
  return undefined;
}

function ignoredAffixes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length);
}

function withoutProvider(id: string): string {
  const slashIndex = id.lastIndexOf("/");
  return slashIndex >= 0 ? id.slice(slashIndex + 1) : id;
}

/** Find the first canonical catalog model whose provider-stripped ID matches the affix-cleaned model ID. */
export function findModelsDevEntry(
  data: ModelsDevData,
  modelID: string,
  options?: Pick<OpenCodeDiscoveryOptions, "modelsDevIgnorePrefixes" | "modelsDevIgnorePostfixes">,
): ModelsDevModel | undefined {
  const prefixes = ignoredAffixes(options?.modelsDevIgnorePrefixes);
  const postfixes = ignoredAffixes(options?.modelsDevIgnorePostfixes);
  let id = withoutProvider(modelID);
  const prefix = prefixes.find((value) => id.startsWith(value));
  if (prefix) id = id.slice(prefix.length);
  const postfix = postfixes.find((value) => id.endsWith(value));
  if (postfix) id = id.slice(0, -postfix.length);
  if (!id) return undefined;

  return Object.values(data).find((model) => withoutProvider(model.id) === id);
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
