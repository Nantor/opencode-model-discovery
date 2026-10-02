import { Model, Provider } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";

import {
  discoveryCacheKey,
  isArrayOf,
  parseCacheDuration,
  readCache,
  writeCache,
} from "./cache.js";
import {
  fetchModelInfo,
  fetchModels,
  isLiteLLMModel,
  isLiteLLMModelInfoEntry,
} from "./fetch.js";
import { enhanceModelEntry, findModelsDevEntry, getModelsDevData } from "./models-dev.js";
import { buildProviderConfig } from "./provider.js";
import type {
  LiteLLMModel,
  LiteLLMModelInfoEntry,
  Logger,
  OpenCodeConfig,
  OpenCodeModelEntry,
  OpenCodeProvider,
} from "./types.js";

type RequestBodyTransform = (
  body: Record<string, unknown>,
) => Record<string, unknown>;

const MAX_COMPLETION_TOKENS = Symbol("maxCompletionTokens");

// LiteLLM `model_info.mode` values that can never serve /chat/completions.
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

  const known = new Set<string>();
  const resolved: LiteLLMModelInfoEntry[] = [];
  for (const id of modelIDs) {
    if (known.has(id)) continue;
    known.add(id);
    const info = byID.get(id);
    resolved.push(
      info
        ? { ...info, model_name: id }
        : { model_name: id, litellm_params: { model: id }, model_info: {} },
    );
  }

  // Wildcard routes missing from /v1/models expose their usable id only via
  // litellm_params.model. Add those as a fallback, but preserve the exact
  // route ID when /v1/models already reported it.
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

  for (const modelID of modelIDs) {
    const model = provider.models?.[modelID];
    if (model) {
      Object.defineProperty(model, MAX_COMPLETION_TOKENS, { value: true });
    }
  }

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

  const timeoutMs =
    typeof pluginOptions.discoveryTimeout === "number" &&
    Number.isFinite(pluginOptions.discoveryTimeout) &&
    pluginOptions.discoveryTimeout >= 0
      ? pluginOptions.discoveryTimeout
      : undefined;

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
    const cachedModels = cacheDurationMs === undefined
      ? undefined
      : await readCache(modelsCacheKey, cacheDurationMs, isArrayOf(isLiteLLMModel));
    const models: LiteLLMModel[] =
      cachedModels ?? await fetchModels(discoveryBaseURL, options.apiKey, timeoutMs);
    if (cacheDurationMs !== undefined && cachedModels === undefined) {
      await writeCache(modelsCacheKey, models);
    }
    let infoEntries: LiteLLMModelInfoEntry[] = [];
    try {
      const cachedInfo = cacheDurationMs === undefined
        ? undefined
        : await readCache(infoCacheKey, cacheDurationMs, isArrayOf(isLiteLLMModelInfoEntry));
      infoEntries = cachedInfo ?? await fetchModelInfo(discoveryBaseURL, options.apiKey, timeoutMs);
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
  // discoverProviderModels catches its own errors, but one provider must
  // never be able to abort discovery for the others or block startup.
  const results = await Promise.allSettled(
    Object.entries(config.provider ?? {}).map(([providerID, provider]) =>
      discoverProviderModels(providerID, provider, log),
    ),
  );
  const providerIDs = Object.keys(config.provider ?? {});
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      await safeLog(
        log,
        "error",
        `Model discovery failed for "${providerIDs[index]}": ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }
}

export const ModelDiscoveryPlugin = async (ctx: Context): Promise<void> => {
  const log: Logger = (level, message) => console[level](`[opencode-model-discovery] ${message}`);
  const discoveredModels = new Map<string, Map<string, Model.Info>>();
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
        await discoverProviderModels(providerID, provider, log);
        if (provider.models) {
          discoveredModels.set(
            providerID,
            new Map(modelsToV2(providerID, provider.models).map((model) => [model.id, model])),
          );
        }
        await ctx.model.reload();
      })().catch((error: unknown) => {
        console.error("[opencode-model-discovery]", error);
      });
    }

    for (const [providerID, models] of discoveredModels) {
      const provider = editor.provider.get(providerID);
      if (!provider) continue;
      for (const [modelID, discoveredModel] of models) {
        // ProviderRecord.models is the configured source inventory. Do not
        // use ModelEditor.get() here: it resolves a candidate and therefore
        // is not a reliable indication that the user configured an override.
        if (provider.models.has(modelID)) continue;
        editor.update(providerID, modelID, (model) => {
          Object.assign(model, discoveredModel);
        });
      }
    }
  });
};

function providerFromV2(info: {
  id: string;
  name: string;
  settings?: Record<string, unknown>;
}): OpenCodeProvider {
  return {
    name: info.name,
    options: info.settings as OpenCodeProvider["options"],
  };
}

function modelsToV2(
  providerID: string,
  models: Record<string, OpenCodeModelEntry>,
): Array<Model.Info> {
  return Object.entries(models).map(([id, entry]) => {
    const model: {
      id: string;
      modelID: string;
      providerID: string;
      name: string;
      family?: string;
      capabilities: { tools: boolean; input: string[]; output: string[] };
      variants: Model.Info["variants"];
      time: Model.Info["time"];
      cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>;
      status: Model.Info["status"];
      enabled: boolean;
      limit: { context: number; input?: number; output: number };
      compatibility?: { reasoningField?: string; maxTokensField?: "max_completion_tokens" };
    } = Model.Info.default(
      Provider.ID.make(providerID),
      Model.ID.make(id),
    ) as unknown as typeof model;
    model.name = entry.name ?? id;
    if (entry.family !== undefined) model.family = entry.family as Model.Info["family"];
    if (entry.limit) model.limit = entry.limit;
    if (entry.cost) {
      model.cost = [{
        input: entry.cost.input,
        output: entry.cost.output,
        cache: { read: entry.cost.cache_read ?? 0, write: entry.cost.cache_write ?? 0 },
      }];
    }
    if (entry.tool_call !== undefined) model.capabilities.tools = entry.tool_call;
    if (entry.modalities) model.capabilities = {
      ...model.capabilities,
      input: entry.modalities.input,
      output: entry.modalities.output,
    };
    if (entry.reasoning === true) {
      model.compatibility = { ...model.compatibility, reasoningField: "reasoning_content" };
    }
    if ((entry as Record<PropertyKey, unknown>)[MAX_COMPLETION_TOKENS] === true) {
      model.compatibility = { ...model.compatibility, maxTokensField: "max_completion_tokens" };
    }
    return model as unknown as Model.Info;
  });
}
