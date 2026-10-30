import type { Provider } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";

import {
  discoveryCacheKey,
  isArrayOf,
  parseCacheDuration,
  readCache,
  type Storage,
  writeCache,
} from "./cache.js";
import {
  discoveryTimeout,
  fetchModelInfo,
  fetchModels,
  isLiteLLMModel,
  isLiteLLMModelInfoEntry,
} from "./fetch.js";
import { enhanceModelInfo, findModelsDevEntry, getModelsDevData } from "./models-dev.js";
import { applyModelInfoDraft, materializeModelInfo, modelInfoDraft } from "./model.js";
import { buildProviderConfig, modelLimitDraft } from "./provider.js";
import { errorMessage, fillMissingFields, safeLog } from "./utils.js";
import type {
  LiteLLMModelInfoEntry,
  DiscoveredModelInfo,
  Logger,
  OpenCodeConfig,
  OpenCodeModelEntry,
  OpenCodeProvider,
} from "./types.js";

type RequestBodyTransform = (
  body: Record<string, unknown>,
) => Record<string, unknown>;

const runtimeDrafts = new WeakMap<OpenCodeModelEntry, DiscoveredModelInfo>();

// LiteLLM `/models` and `model_info.mode` values that can never serve /chat/completions.
// `chat`, `completion` and `responses` are deliberately absent: LiteLLM
// routes chat requests to those deployments.
const ENDPOINT_ONLY_MODEL_MODES = new Set([
  "embedding",
  "audio_transcription",
  "audio_speech",
  "moderation",
  "moderations",
  "rerank",
  "image_generation",
  "image_edit",
  "video_generation",
  "ocr",
  "realtime",
  "batch",
]);

async function readOrFetchCache<T>(
  storage: Storage | undefined,
  key: string,
  cacheDurationMs: number | undefined,
  fetch: () => Promise<T[]>,
  isItem: (value: unknown) => value is T,
  allowPartialCache = false,
): Promise<T[]> {
  if (!storage || cacheDurationMs === undefined) return fetch();
  const isCachedValue = allowPartialCache
    ? (value: unknown): value is unknown[] => Array.isArray(value)
    : isArrayOf(isItem);
  const cached = await readCache(storage, key, cacheDurationMs, isCachedValue);
  if (cached !== undefined) return cached.filter(isItem);
  const fresh = await fetch();
  await writeCache(storage, key, fresh);
  return fresh;
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

  const known = new Set<string>();
  const resolved: LiteLLMModelInfoEntry[] = [];
  for (const modelID of modelIDs) {
    const info = byID.get(modelID);
    // Metadata may match an upstream alias, but only model_name is the
    // public route ID. Never expose litellm_params.model or model_info.key.
    const id = info?.model_name ?? modelID;
    if (known.has(id)) continue;
    known.add(id);
    resolved.push(
      info
        ? info
        : { model_name: id, litellm_params: { model: id }, model_info: {} },
    );
  }

  // Keep wildcard routes missing from /v1/models under their public names,
  // even when multiple routes share an upstream deployment.
  for (const entry of infoEntries) {
    if (!entry.model_name.endsWith("*")) continue;
    if (known.has(entry.model_name)) continue;
    known.add(entry.model_name);
    resolved.push(entry);
  }

  return resolved;
}

function maxTokensField(entry: LiteLLMModelInfoEntry): "max_tokens" | "max_completion_tokens" | undefined {
  const parameters = entry.model_info.supported_openai_params;
  // Prefer the newer parameter when both are supported; absent metadata leaves
  // OpenCode's provider/endpoint detection in charge.
  if (parameters?.includes("max_completion_tokens")) return "max_completion_tokens";
  if (parameters?.includes("max_tokens")) return "max_tokens";
  return undefined;
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
      .filter((entry) => maxTokensField(entry) === "max_completion_tokens")
      .map((entry) => entry.model_name),
  );
  if (modelIDs.size === 0) return;

  // `transformRequestBody` is the request hook of @ai-sdk/openai-compatible.
  // OpenCode forwards `provider.options` to the adapter factory verbatim, and
  // its config merge preserves function references, so the function survives
  // to `createOpenAICompatible(...)`. JSON config cannot carry functions, so
  // an existing transform can only come from another plugin that ran before
  // this one; chain it rather than replace it.
  //
  // Alternative if this coupling ever breaks: wrap `provider.options.fetch`
  // (explicitly supported by OpenCode for any adapter) and rewrite the JSON
  // body there.
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
  storage?: Storage,
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

  const discoveryBaseURL =
    typeof pluginOptions.discoveryBaseURL === "string"
      ? pluginOptions.discoveryBaseURL
      : options.baseURL;

  const timeoutMs = discoveryTimeout(pluginOptions.discoveryTimeout);

  try {
    const cacheDurationMs = parseCacheDuration(pluginOptions.discoveryCache);
    if (pluginOptions.discoveryCache !== undefined && cacheDurationMs === undefined) {
      await safeLog(
        log,
        "warn",
        `Ignoring invalid discoveryCache "${String(pluginOptions.discoveryCache)}" for provider "${providerID}": expected a positive ISO 8601 duration such as "PT1H" or "P1D" (months and years are not supported)`,
      );
    }
    const modelsCacheKey = discoveryCacheKey("models", discoveryBaseURL, options.apiKey);
    const infoCacheKey = discoveryCacheKey("model-info", discoveryBaseURL, options.apiKey);
    const models = await readOrFetchCache(
      storage,
      modelsCacheKey,
      cacheDurationMs,
      () => fetchModels(discoveryBaseURL, options.apiKey, timeoutMs),
      isLiteLLMModel,
    );
    let infoEntries: LiteLLMModelInfoEntry[] = [];
    try {
      infoEntries = await readOrFetchCache(
        storage,
        infoCacheKey,
        cacheDurationMs,
        () => fetchModelInfo(discoveryBaseURL, options.apiKey, timeoutMs),
        isLiteLLMModelInfoEntry,
        // Older caches can contain malformed entries. Keep usable metadata even
        // when refetching the optional endpoint would fail.
        true,
      );
    } catch (error) {
      await safeLog(
        log,
        "warn",
        `Could not fetch detailed model info for "${providerID}": ${errorMessage(error)}`,
      );
    }

    const excludedModelIDs = new Set(
      models
        .filter((model) => typeof model.mode === "string" && ENDPOINT_ONLY_MODEL_MODES.has(model.mode.toLowerCase()))
        .map((model) => model.id),
    );
    const discoveredEntries = entriesForModels(
      models.map((model) => model.id),
      infoEntries,
    ).filter((entry) =>
      !excludedModelIDs.has(entry.model_name) &&
      !excludedModelIDs.has(entry.litellm_params.model ?? entry.model_name) &&
      isOpenCodeModel(entry),
    );
    const discovered = buildProviderConfig(
      discoveredEntries,
      options.baseURL,
      options.apiKey,
      provider.name ?? providerID,
      false,
    );

    for (const entry of discoveredEntries) {
      const model = discovered.models?.[entry.model_name];
      if (!model) continue;
      const info = entry.model_info;
      const draft = modelInfoDraft(model, info);
      const tokenField = maxTokensField(entry);
      if (tokenField) {
        draft.compatibility = { ...draft.compatibility, maxTokensField: tokenField };
      }
      // Read limits directly from metadata: the legacy bridge cannot represent partial limits.
      const limit = modelLimitDraft(info);
      if (limit) draft.limit = limit;
      // Preserve explicit negative capabilities; catalog data must not override them.
      if (info.supports_function_calling === false && info.supports_tool_choice !== true) {
        draft.capabilities = { ...draft.capabilities, tools: false };
      }
      runtimeDrafts.set(model, draft);
    }

    if (pluginOptions.enhanceFromModelsDev === true) {
      const modelsDevData = await getModelsDevData(log);
      if (modelsDevData) {
        for (const entry of discoveredEntries) {
          const modelEntry = discovered.models?.[entry.model_name];
          if (!modelEntry) continue;
          const modelsDevEntry = findModelsDevEntry(
            modelsDevData,
            entry.model_name,
            pluginOptions,
          );
          if (modelsDevEntry) {
            const draft = runtimeDrafts.get(modelEntry) ?? modelInfoDraft(modelEntry);
            enhanceModelInfo(draft, modelsDevEntry,
              typeof entry.model_info.supports_reasoning === "boolean" || typeof entry.model_info.reasoning === "boolean",
              entry.model_info);
            applyModelInfoDraft(modelEntry, draft);
          }
        }
      }
    }

    const configuredModels = provider.models;
    provider.models = {
      ...discovered.models,
      ...configuredModels,
    };
    if (pluginOptions.enrichExistingModels === true) {
      for (const [id, configured] of Object.entries(configuredModels ?? {})) {
        const model = discovered.models?.[id];
        if (model) provider.models[id] = fillMissingFields(configured, model);
      }
    }
    addMaxCompletionTokensTransform(provider, discoveredEntries);
    await safeLog(log, "info", `Discovered ${discoveredEntries.length} usable model(s) for provider "${providerID}"`);
  } catch (error) {
    await safeLog(
      log,
      "error",
      `Model discovery failed for "${providerID}": ${errorMessage(error)}`,
    );
  }
}

export async function applyDiscovery(
  config: OpenCodeConfig,
  log?: Logger,
  storage?: Storage,
): Promise<void> {
  // discoverProviderModels catches its own errors, but one provider must
  // never be able to abort discovery for the others or block startup.
  const results = await Promise.allSettled(
    Object.entries(config.provider ?? {}).map(([providerID, provider]) =>
      discoverProviderModels(providerID, provider, log, storage),
    ),
  );
  const providerIDs = Object.keys(config.provider ?? {});
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      await safeLog(
        log,
        "error",
        `Model discovery failed for "${providerIDs[index]}": ${errorMessage(result.reason)}`,
      );
    }
  }
}

export const ModelDiscoveryPlugin = async (ctx: Context): Promise<void> => {
  const log: Logger = (level, message) => console[level](`[opencode-model-discovery] ${message}`);
  const discoveredModels = new Map<string, {
    models: Map<string, DiscoveredModelInfo>;
    enrichExistingModels: boolean;
  }>();
  const discoveryStarted = new Set<string>();

  // This cleanup is independent of discovery. It can run before configured
  // providers are materialized; the config provider transform will apply its
  // own settings afterwards.
  await ctx.provider.transform((editor) => {
    for (const provider of editor.list()) {
      editor.update(provider.provider.id, (info) => {
        delete info.settings?.["opencode-model-discovery"];
      });
    }
  });

  // Model transforms run after provider sources have been materialized. A
  // provider transform registered here runs before OpenCode's configuration
  // source and therefore cannot add inventory for configured providers.
  // ModelEditor.update can create a model for an available provider.
  await ctx.model.transform((editor) => {
    for (const record of editor.provider.list()) {
      const providerID = record.provider.id;
      if (discoveryStarted.has(providerID)) continue;

      const provider = providerFromV2(record.provider);
      const pluginOptions = provider.options?.["opencode-model-discovery"];
      if (pluginOptions?.discovery !== true) continue;

      discoveryStarted.add(providerID);
      // Transforms are synchronous. Start discovery from the post-config
      // source visible here, then reload to replay this transform once the
      // discovered inventory is available. Do not register another transform.
      void (async (): Promise<void> => {
        await discoverProviderModels(providerID, provider, log, ctx.storage);
        if (provider.models) {
          discoveredModels.set(
            providerID,
            {
              models: modelDraftsToV2(provider.models),
              enrichExistingModels: pluginOptions.enrichExistingModels === true,
            },
          );
        }
        await ctx.model.reload();
      })().catch((error: unknown) => {
        console.error("[opencode-model-discovery]", error);
      });
    }

    for (const [providerID, { models, enrichExistingModels }] of discoveredModels) {
      const provider = editor.provider.get(providerID);
      if (!provider) continue;
      for (const [modelID, discoveredModel] of models) {
        // ProviderRecord.models is the configured source inventory. Do not
        // use ModelEditor.get() here: it resolves a candidate and therefore
        // is not a reliable indication that the user configured an override.
        const existing = provider.models.has(modelID);
        if (existing && !enrichExistingModels) continue;
        editor.update(providerID, modelID, (model) => {
          // Update callbacks expose raw overrides. Merge before runtime defaults
          // so a name-only entry can acquire limits, capabilities and pricing.
          Object.assign(model, existing
            ? fillMissingFields(model, discoveredModel)
            : materializeModelInfo(providerID, modelID, discoveredModel));
        });
      }
    }
  });
};

function providerFromV2(info: Pick<Provider.Info, "id" | "name" | "settings">): OpenCodeProvider {
  return {
    name: info.name,
    options: info.settings as OpenCodeProvider["options"],
  };
}

function modelDraftsToV2(
  models: Record<string, OpenCodeModelEntry>,
): Map<string, DiscoveredModelInfo> {
  return new Map(Object.entries(models).map(([id, entry]) => {
    return [id, { ...(runtimeDrafts.get(entry) ?? modelInfoDraft(entry)) }];
  }));
}
