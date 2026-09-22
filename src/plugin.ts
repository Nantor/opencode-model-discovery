import type { Plugin } from "@opencode-ai/plugin";

import { discoveryCacheKey, parseCacheDuration, readCache, writeCache } from "./cache.js";
import { fetchModelInfo, fetchModels } from "./fetch.js";
import { enhanceModelEntry, findModelsDevEntry, getModelsDevData } from "./models-dev.js";
import { buildProviderConfig } from "./provider.js";
import type {
  LiteLLMModelInfoEntry,
  Logger,
  OpenCodeConfig,
  OpenCodeProvider,
} from "./types.js";

type RequestBodyTransform = (
  body: Record<string, unknown>,
) => Record<string, unknown>;

const ENDPOINT_ONLY_MODEL_MODES = new Set([
  "embedding",
  "audio_transcription",
  "audio_speech",
  "moderation",
  "rerank",
]);

async function safeLog(
  log: Logger | undefined,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await log?.(level, message);
  } catch {
    // Logging must never prevent provider initialization.
  }
}

function entriesForModels(
  modelIDs: string[],
  infoEntries: LiteLLMModelInfoEntry[],
): LiteLLMModelInfoEntry[] {
  const byID = new Map<string, LiteLLMModelInfoEntry>();
  for (const entry of infoEntries) {
    byID.set(entry.model_name, entry);
  }
  for (const entry of infoEntries) {
    if (entry.litellm_params.model) {
      if (!byID.has(entry.litellm_params.model)) {
        byID.set(entry.litellm_params.model, entry);
      }
    }
  }

  const resolved: LiteLLMModelInfoEntry[] = modelIDs.map((id) => {
    const info = byID.get(id);
    if (!info) {
      return { model_name: id, litellm_params: { model: id }, model_info: {} };
    }
    return { ...info, model_name: id };
  });

  // Wildcard routes missing from /v1/models expose their usable id only via
  // litellm_params.model. Add those as a fallback, but preserve the exact
  // route ID when /v1/models already reported it.
  const known = new Set(modelIDs);
  const wildcardTargets = new Set<string>();
  for (const entry of infoEntries) {
    if (!entry.model_name.endsWith("*")) continue;
    if (known.has(entry.model_name)) continue;
    const target = entry.litellm_params.model;
    if (!target || known.has(target) || wildcardTargets.has(target)) continue;
    wildcardTargets.add(target);
    resolved.push({ ...entry, model_name: target, litellm_params: entry.litellm_params });
  }

  return resolved;
}

function usesMaxCompletionTokens(entry: LiteLLMModelInfoEntry): boolean {
  const parameters = entry.model_info.supported_openai_params;
  return parameters?.includes("max_completion_tokens") === true;
}

function isOpenCodeModel(entry: LiteLLMModelInfoEntry): boolean {
  const mode = entry.model_info.mode?.toLowerCase();
  // LiteLLM providers may use custom modes for otherwise chat-capable models.
  // Exclude only endpoint-specific modes that cannot serve chat completions.
  return mode === undefined || !ENDPOINT_ONLY_MODEL_MODES.has(mode);
}

function addMaxCompletionTokensTransform(
  provider: OpenCodeProvider,
  entries: LiteLLMModelInfoEntry[],
): void {
  const modelIDs = new Set(
    entries
      .filter(usesMaxCompletionTokens)
      .map((entry) => entry.model_name),
  );
  if (modelIDs.size === 0) return;

  const existingTransform = provider.options?.transformRequestBody;
  const transform = typeof existingTransform === "function"
    ? existingTransform as RequestBodyTransform
    : undefined;

  provider.options = {
    ...provider.options,
    transformRequestBody: (body: Record<string, unknown>): Record<string, unknown> => {
      const transformed = transform ? transform(body) : body;
      if (
        typeof transformed.model !== "string" ||
        !modelIDs.has(transformed.model) ||
        !Object.hasOwn(transformed, "max_tokens")
      ) {
        return transformed;
      }

      const { max_tokens, ...rest } = transformed;
      return { ...rest, max_completion_tokens: max_tokens };
    },
  };
}

export async function discoverProviderModels(
  providerID: string,
  provider: OpenCodeProvider | undefined,
  log?: Logger,
): Promise<void> {
  if (!provider) return;
  const options = provider.options;
  const pluginOptions = options?.["opencode-model-discovery"];
  if (pluginOptions?.discovery !== true) return;

  if (options) {
    const { ["opencode-model-discovery"]: _pluginConfig, ...adapterOptions } = options;
    provider.options = adapterOptions;
  }

  if (!options?.baseURL) {
    await safeLog(log, "warn", `Provider "${providerID}" has discovery enabled but no baseURL`);
    return;
  }

  const timeoutMs =
    typeof pluginOptions.discoveryTimeout === "number" &&
    Number.isFinite(pluginOptions.discoveryTimeout) &&
    pluginOptions.discoveryTimeout >= 0
      ? pluginOptions.discoveryTimeout
      : undefined;

  try {
    const cacheDurationMs = parseCacheDuration(pluginOptions.discoveryCache);
    const modelsCacheKey = discoveryCacheKey("models", options.baseURL, options.apiKey);
    const infoCacheKey = discoveryCacheKey("model-info", options.baseURL, options.apiKey);
    const cachedModels = cacheDurationMs === undefined
      ? undefined
      : await readCache<Awaited<ReturnType<typeof fetchModels>>>(modelsCacheKey, cacheDurationMs);
    const models = cachedModels ?? await fetchModels(options.baseURL, options.apiKey, timeoutMs);
    if (cacheDurationMs !== undefined && cachedModels === undefined) {
      await writeCache(modelsCacheKey, models);
    }
    let infoEntries: LiteLLMModelInfoEntry[] = [];
    try {
      const cachedInfo = cacheDurationMs === undefined
        ? undefined
        : await readCache<LiteLLMModelInfoEntry[]>(infoCacheKey, cacheDurationMs);
      infoEntries = cachedInfo ?? await fetchModelInfo(options.baseURL, options.apiKey, timeoutMs);
      if (cacheDurationMs !== undefined && cachedInfo === undefined) {
        await writeCache(infoCacheKey, infoEntries);
      }
    } catch (error) {
      await safeLog(
        log,
        "warn",
        `Could not fetch detailed model info for "${providerID}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const discoveredEntries = entriesForModels(
      models.map((model) => model.id),
      infoEntries,
    ).filter(isOpenCodeModel);
    const discovered = buildProviderConfig(
      discoveredEntries,
      options.baseURL,
      options.apiKey,
      provider.name ?? providerID,
      false,
      typeof pluginOptions.modelNameFormat === "string"
        ? pluginOptions.modelNameFormat
        : undefined,
      providerID,
      log,
    );

    if (pluginOptions.enhanceFromModelsDev === true) {
      const modelsDevData = await getModelsDevData(cacheDurationMs, timeoutMs, log);
      if (modelsDevData) {
        for (const entry of discoveredEntries) {
          const modelEntry = discovered.models?.[entry.model_name];
          if (!modelEntry) continue;
          const modelsDevEntry = findModelsDevEntry(
            modelsDevData,
            entry.model_info.litellm_provider,
            entry.litellm_params.model ?? entry.model_name,
          );
          if (modelsDevEntry) {
            enhanceModelEntry(modelEntry, modelsDevEntry);
          }
        }
      }
    }

    provider.models = {
      ...discovered.models,
      ...provider.models,
    };
    addMaxCompletionTokensTransform(provider, discoveredEntries);
    await safeLog(log, "info", `Discovered ${discoveredEntries.length} usable model(s) for provider "${providerID}"`);
  } catch (error) {
    await safeLog(
      log,
      "error",
      `Model discovery failed for "${providerID}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function applyDiscovery(
  config: OpenCodeConfig,
  log?: Logger,
): Promise<void> {
  await Promise.all(
    Object.entries(config.provider ?? {}).map(([providerID, provider]) =>
      discoverProviderModels(providerID, provider, log),
    ),
  );
}

export const ModelDiscoveryPlugin: Plugin = async ({ client }) => {
  const log: Logger = async (level, message) => {
    await client.app.log({
      body: {
        service: "opencode-model-discovery",
        level,
        message,
      },
    });
  };

  return {
    config: async (config) => applyDiscovery(config as OpenCodeConfig, log),
  };
};
