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
// Fills gaps in discovered model metadata (family, release date, cost,
// limits, modalities, ...) using the public models.dev catalog. LiteLLM
// discovery data always wins; models.dev is only used to fill fields that
// LiteLLM's /v2/model/info did not report.

function modelsDevCachePath(): string {
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "opencode",
    "models.json",
  );
}

// Maps LiteLLM's `litellm_provider` metadata to the corresponding models.dev
// provider id. Only providers with a confident, unambiguous mapping are
// listed here; anything else is treated as "no match" rather than guessed,
// since a wrong guess could attach another provider's pricing to a model.
const LITELLM_PROVIDER_TO_MODELS_DEV: Record<string, string> = {
  openai: "openai",
  azure: "azure",
  anthropic: "anthropic",
  vertex_ai: "google-vertex",
  "vertex_ai-language-models": "google-vertex",
  "vertex_ai-anthropic_models": "google-vertex-anthropic",
  "vertex_ai-image-models": "google-vertex",
  bedrock: "amazon-bedrock",
  bedrock_converse: "amazon-bedrock",
  gemini: "google",
  mistral: "mistral",
  codestral: "mistral",
  cohere: "cohere",
  cohere_chat: "cohere",
  groq: "groq",
  deepseek: "deepseek",
  xai: "xai",
  perplexity: "perplexity",
  cerebras: "cerebras",
  databricks: "databricks",
  watsonx: "watsonx",
  huggingface: "huggingface",
  fireworks_ai: "fireworks-ai",
  together_ai: "togetherai",
  openrouter: "openrouter",
  nvidia_nim: "nvidia",
};

// Provider gateways sometimes expose a model under a shorter route ID than
// its canonical models.dev ID. Keep these explicit so fallback metadata stays
// deterministic even when an ID is shared by several catalog providers.

function isModelsDevData(value: unknown): value is ModelsDevData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (provider) =>
      typeof provider === "object" &&
      provider !== null &&
      typeof (provider as Partial<ModelsDevProvider>).models === "object" &&
      (provider as Partial<ModelsDevProvider>).models !== null,
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

/**
 * Strip a single leading path segment from a LiteLLM-resolved model id when
 * it matches the model's `litellm_provider`, e.g. "azure/gpt-4o" -> "gpt-4o"
 * or "vertex_ai/claude-opus-4-5@20251101" -> "claude-opus-4-5@20251101".
 */
function stripLiteLLMPrefix(id: string, litellmProvider: string): string {
  const separatorIndex = id.indexOf("/");
  if (separatorIndex === -1) return id;
  const prefix = id.slice(0, separatorIndex).toLowerCase();
  if (!litellmProvider.toLowerCase().startsWith(prefix)) return id;
  return id.slice(separatorIndex + 1);
}

function fallbackModelsDevID(id: string): string {
  // LiteLLM regional routes such as US-gpt-5.4 use the upstream model ID in
  // models.dev without the region prefix.
  return id.replace(/^US-/, "");
}

function findUnambiguousModelsDevEntry(
  data: ModelsDevData,
  resolvedID: string,
): ModelsDevModel | undefined {
  const modelID = fallbackModelsDevID(resolvedID);
  const matches = Object.values(data)
    .map((provider) => provider.models[modelID])
    .filter((model): model is ModelsDevModel => model !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

function findFallbackModelsDevEntry(
  data: ModelsDevData,
  resolvedID: string,
): ModelsDevModel | undefined {
  const canonicalID = MODELS_DEV_FALLBACK_ALIASES[resolvedID];
  if (canonicalID) {
    const matches = Object.values(data)
      .flatMap((provider) => Object.values(provider.models))
      .filter((model) => model.id === canonicalID || model.canonical_model_id === canonicalID);
    return matches.find((model) => model.id === canonicalID) ?? matches[0];
  }
  return findUnambiguousModelsDevEntry(data, resolvedID);
}

/**
 * Find the models.dev entry for a discovered model, using its
 * `litellm_provider` metadata to select the models.dev provider and the
 * LiteLLM-resolved model id (with any redundant provider prefix stripped) as
 * the lookup key. When LiteLLM omits provider metadata, uses an exact catalog
 * ID match only when it occurs under exactly one models.dev provider.
 */
function findModelsDevEntryByID(
  data: ModelsDevData,
  litellmProvider: string | undefined,
  resolvedID: string,
): ModelsDevModel | undefined {
  if (!litellmProvider) return findFallbackModelsDevEntry(data, resolvedID);
  const providerID = LITELLM_PROVIDER_TO_MODELS_DEV[litellmProvider.toLowerCase()];
  if (!providerID) return undefined;

  const provider = data[providerID];
  if (!provider?.models) return undefined;

  const strippedID = stripLiteLLMPrefix(resolvedID, litellmProvider);
  return provider.models[strippedID] ?? provider.models[resolvedID];
}

function ignoredAffixes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length);
}

/** Try the original ID first; configured affixes only affect fallback lookup. */
export function findModelsDevEntry(
  data: ModelsDevData,
  litellmProvider: string | undefined,
  resolvedID: string,
  options?: Pick<OpenCodeDiscoveryOptions, "modelsDevIgnorePrefixes" | "modelsDevIgnorePostfixes">,
): ModelsDevModel | undefined {
  const original = findModelsDevEntryByID(data, litellmProvider, resolvedID);
  if (original) return original;

  const prefixes = ignoredAffixes(options?.modelsDevIgnorePrefixes);
  const postfixes = ignoredAffixes(options?.modelsDevIgnorePostfixes);
  // Also handle an affix immediately after a redundant LiteLLM provider path.
  const candidates = new Set([
    resolvedID,
    litellmProvider ? stripLiteLLMPrefix(resolvedID, litellmProvider) : resolvedID,
  ]);
  for (const candidate of candidates) {
    let id = candidate;
    const prefix = prefixes.find((value) => id.startsWith(value));
    if (prefix) id = id.slice(prefix.length);
    const postfix = postfixes.find((value) => id.endsWith(value));
    if (postfix) id = id.slice(0, -postfix.length);
    if (!id || id === candidate) continue;
    const match = findModelsDevEntryByID(data, litellmProvider, id);
    if (match) return match;
  }
  return undefined;
}

/**
 * Fill gaps in a discovered model entry using models.dev metadata. Fields
 * already populated from LiteLLM discovery are left untouched; only fields
 * that are still `undefined` are set.
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

  if (modelEntry.cost === undefined && modelsDevEntry.cost) {
    const { input, output, cache_read, cache_write } = modelsDevEntry.cost;
    if (typeof input === "number" && typeof output === "number") {
      modelEntry.cost = {
        input,
        output,
        ...(typeof cache_read === "number" ? { cache_read } : {}),
        ...(typeof cache_write === "number" ? { cache_write } : {}),
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
