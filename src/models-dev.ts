import { readCache, writeCache } from "./cache.js";
import type {
  Logger,
  ModelsDevData,
  ModelsDevModel,
  ModelsDevProvider,
  OpenCodeModelEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// models.dev enhancement
// ---------------------------------------------------------------------------
//
// Fills gaps in discovered model metadata (family, release date, cost,
// limits, modalities, ...) using the public models.dev catalog. LiteLLM
// discovery data always wins; models.dev is only used to fill fields that
// LiteLLM's /v2/model/info did not report.

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_KEY = "models-dev-data";
const DEFAULT_TIMEOUT_MS = 10_000;

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

async function safeLog(
  log: Logger | undefined,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await log?.(level, message);
  } catch {
    // Logging must never prevent discovery.
  }
}

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

async function fetchModelsDevData(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ModelsDevData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${MODELS_DEV_URL}`);
    }
    return (await res.json()) as ModelsDevData;
  } finally {
    clearTimeout(timeout);
  }
}

// De-duplicates concurrent in-process fetches when several providers opt
// into enhancement within the same discovery run. Keyed by cache duration:
// the on-disk cache file is shared, so a provider with a shorter
// `discoveryCache` must not be handed a result another provider accepted
// under a longer freshness window. Cleared once the fetch settles so later,
// independent discovery runs re-check the disk cache.
const inFlightFetches = new Map<number | undefined, Promise<ModelsDevData | undefined>>();

/**
 * Fetch models.dev's model catalog, using an on-disk cache (when
 * `cacheDurationMs` is set).
 */
export async function getModelsDevData(
  cacheDurationMs: number | undefined,
  timeoutMs: number | undefined,
  log?: Logger,
): Promise<ModelsDevData | undefined> {
  const inFlight = inFlightFetches.get(cacheDurationMs);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<ModelsDevData | undefined> => {
    try {
      const cached = cacheDurationMs === undefined
        ? undefined
        : await readCache(MODELS_DEV_CACHE_KEY, cacheDurationMs, isModelsDevData);
      if (cached) return cached;

      const data = await fetchModelsDevData(timeoutMs);
      if (cacheDurationMs !== undefined) {
        await writeCache(MODELS_DEV_CACHE_KEY, data);
      }
      return data;
    } catch (error) {
      await safeLog(
        log,
        "warn",
        `Could not fetch models.dev data: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  })();

  inFlightFetches.set(cacheDurationMs, promise);
  try {
    return await promise;
  } finally {
    inFlightFetches.delete(cacheDurationMs);
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

/**
 * Find the models.dev entry for a discovered model, using its
 * `litellm_provider` metadata to select the models.dev provider and the
 * LiteLLM-resolved model id (with any redundant provider prefix stripped) as
 * the lookup key. Returns undefined when no confident match is found.
 */
export function findModelsDevEntry(
  data: ModelsDevData,
  litellmProvider: string | undefined,
  resolvedID: string,
): ModelsDevModel | undefined {
  if (!litellmProvider) return undefined;
  const providerID = LITELLM_PROVIDER_TO_MODELS_DEV[litellmProvider.toLowerCase()];
  if (!providerID) return undefined;

  const provider = data[providerID];
  if (!provider?.models) return undefined;

  const strippedID = stripLiteLLMPrefix(resolvedID, litellmProvider);
  return provider.models[strippedID] ?? provider.models[resolvedID];
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
