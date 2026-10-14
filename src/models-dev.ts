import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  Logger,
  ModelsDevData,
  ModelsDevModel,
  ModelsDevProvider,
  OpenCodeModelEntry,
  OpenCodeDiscoveryOptions,
} from "./types.js";
import { errorMessage, safeLog } from "./utils.js";

// ---------------------------------------------------------------------------
// models.dev enhancement
// ---------------------------------------------------------------------------
//
// Fills gaps in discovered model metadata (family, release date,
// limits, modalities, ...) using the public models.dev catalog. LiteLLM
// discovery data always wins; models.dev is only used to fill fields that
// LiteLLM's /v2/model/info did not report. Pricing is never copied from the catalog.

function modelsDevCachePath(): string {
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "opencode",
    "models.json",
  );
}

function isModelsDevData(value: unknown): value is ModelsDevData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (provider) => {
      if (typeof provider !== "object" || provider === null || Array.isArray(provider)) return false;
      const { id, models } = provider as Partial<ModelsDevProvider>;
      if (typeof id !== "string" || typeof models !== "object" || models === null || Array.isArray(models)) {
        return false;
      }
      return Object.values(models).every(
        (model) => typeof model === "object" && model !== null && !Array.isArray(model) &&
          typeof model.id === "string",
      );
    },
  );
}

/**
 * Read OpenCode's local models.dev catalog. OpenCode maintains this richer
 * snapshot at ~/.cache/opencode/models.json, including canonical model IDs.
 */
export async function getModelsDevData(
  log?: Logger,
): Promise<ModelsDevData | undefined> {
  const path = modelsDevCachePath();
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isModelsDevData(data) ? data : undefined;
  } catch (error) {
    await safeLog(
      log,
      "warn",
      `Could not read OpenCode models catalog at ${path}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

function ignoredAffixes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length);
}

/** Find the first catalog model whose ID ends with the affix-cleaned ID, regardless of provider. */
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

  for (const provider of Object.values(data)) {
    const match = Object.values(provider.models).find((model) => model.id.endsWith(id));
    if (match) return match;
  }
  return undefined;
}

/**
 * Fill gaps in a discovered model entry using models.dev metadata. Fields
 * already populated from LiteLLM discovery are left untouched; only fields
 * that are still `undefined` are set. Pricing is never read from the catalog.
 */
export function enhanceModelEntry(
  modelEntry: OpenCodeModelEntry,
  modelsDevEntry: ModelsDevModel,
): void {
  if (modelEntry.family === undefined && typeof modelsDevEntry.family === "string") {
    modelEntry.family = modelsDevEntry.family;
  }
  if (modelEntry.release_date === undefined && typeof modelsDevEntry.release_date === "string") {
    modelEntry.release_date = modelsDevEntry.release_date;
  }
  if (modelEntry.temperature === undefined && typeof modelsDevEntry.temperature === "boolean") {
    modelEntry.temperature = modelsDevEntry.temperature;
  }
  if (modelEntry.attachment === undefined && typeof modelsDevEntry.attachment === "boolean") {
    modelEntry.attachment = modelsDevEntry.attachment;
  }
  if (modelEntry.reasoning === undefined && typeof modelsDevEntry.reasoning === "boolean") {
    modelEntry.reasoning = modelsDevEntry.reasoning;
  }
  if (modelEntry.tool_call === undefined && typeof modelsDevEntry.tool_call === "boolean") {
    modelEntry.tool_call = modelsDevEntry.tool_call;
  }

  if (modelEntry.limit === undefined && modelsDevEntry.limit) {
    const { context, output, input } = modelsDevEntry.limit;
    if (typeof context === "number" && typeof output === "number") {
      modelEntry.limit = {
        context,
        output,
        ...(typeof input === "number" ? { input } : {}),
      };
    }
  }

  if (modelEntry.modalities === undefined && modelsDevEntry.modalities) {
    const { input, output } = modelsDevEntry.modalities;
    if (Array.isArray(input) && Array.isArray(output)) {
      modelEntry.modalities = { input, output };
    }
  }
}
