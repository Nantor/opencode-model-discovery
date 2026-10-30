import { createHash } from "node:crypto";
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
import { applyModelInfoDraft, modelInfoDraft, sourceModelOverrides } from "./model.js";
import { buildProviderConfig, modelLimitDraft } from "./provider.js";
import { providerSettings } from "./provider-settings.js";
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
  signal?: AbortSignal,
): Promise<T[]> {
  signal?.throwIfAborted();
  if (!storage || cacheDurationMs === undefined) return fetch();
  const isCachedValue = allowPartialCache
    ? (value: unknown): value is unknown[] => Array.isArray(value)
    : isArrayOf(isItem);
  const cached = await readCache(storage, key, cacheDurationMs, isCachedValue);
  signal?.throwIfAborted();
  if (cached !== undefined) return cached.filter(isItem);
  const fresh = await fetch();
  signal?.throwIfAborted();
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
  lifecycle?: { signal: AbortSignal; fingerprint: string },
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
    // V2 cache entries also follow the complete source/settings identity.
    const cacheScope = lifecycle ? `:${lifecycle.fingerprint}` : "";
    const headers = { ...provider.headers };
    const modelsCacheKey = discoveryCacheKey("models", discoveryBaseURL, options.apiKey, headers) + cacheScope;
    const infoCacheKey = discoveryCacheKey("model-info", discoveryBaseURL, options.apiKey, headers) + cacheScope;
    const models = await readOrFetchCache(
      storage,
      modelsCacheKey,
      cacheDurationMs,
      () => fetchModels(discoveryBaseURL, options.apiKey, timeoutMs, lifecycle?.signal, headers),
      isLiteLLMModel,
      false,
      lifecycle?.signal,
    );
    let infoEntries: LiteLLMModelInfoEntry[] = [];
    try {
      infoEntries = await readOrFetchCache(
        storage,
        infoCacheKey,
        cacheDurationMs,
        () => fetchModelInfo(discoveryBaseURL, options.apiKey, timeoutMs, lifecycle?.signal, headers),
        isLiteLLMModelInfoEntry,
        // Older caches can contain malformed entries. Keep usable metadata even
        // when refetching the optional endpoint would fail.
        true,
        lifecycle?.signal,
      );
    } catch (error) {
      lifecycle?.signal.throwIfAborted();
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

    lifecycle?.signal.throwIfAborted();
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
    if (lifecycle?.signal.aborted) return;
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

type DiscoveryState = {
  fingerprint: string;
  controller: AbortController;
  failures: number;
  result:
    | { status: "in-flight" }
    | { status: "failure"; retryAt: number }
    | { status: "success"; refreshAt: number; models: Map<string, DiscoveredModelInfo>; enrichExistingModels: boolean };
};

// JSON settings compare by value, irrespective of insertion order. Plugins can
// also supply functions/opaque options: compare those by identity. Keep only a
// digest in the state; credentials must not become a plaintext identity.
function createDiscoveryFingerprint(): (source: unknown) => string {
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;
  const identity = (value: object): number => {
    let id = identities.get(value);
    if (id === undefined) identities.set(value, id = nextIdentity++);
    return id;
  };
  return (source) => {
    const seen = new Map<object, number>();
    const encode = (value: unknown): unknown => {
      if (typeof value === "function") return ["function", identity(value)];
      if (value === null || typeof value !== "object") return [typeof value, String(value)];
      if (seen.has(value)) return ["reference", seen.get(value)];
      seen.set(value, seen.size);
      if (Array.isArray(value)) return ["array", value.map(encode)];
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return ["opaque", identity(value)];
      return ["object", Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, encode(item)])];
    };
    return createHash("sha256").update(JSON.stringify(encode(source))).digest("hex");
  };
}

export const ModelDiscoveryPlugin = async (ctx: Context): Promise<() => void> => {
  const log: Logger = (level, message) => console[level](`[opencode-model-discovery] ${message}`);
  const states = new Map<string, DiscoveryState>();
  const discoveryFingerprint = createDiscoveryFingerprint();
  let disposed = false;

  const settings = await providerSettings(ctx, discoveryFingerprint);

  // Model transforms run after provider sources have been materialized. A
  // provider transform can precede sources registered later in startup.
  // ModelEditor.update can create a model for an available provider.
  await ctx.model.transform((editor) => {
    if (disposed) return;
    const records = editor.provider.list();
    const present = new Set<string>(records.map((record) => record.provider.id));
    for (const [id, state] of states) {
      if (present.has(id)) continue;
      state.controller.abort();
      states.delete(id);
    }
    for (const record of records) {
      const providerID = record.provider.id;
      const provider = providerFromV2(record.provider, settings.options(record));
      const pluginOptions = provider.options?.["opencode-model-discovery"];
      let previous = states.get(providerID);
      // Include the privately captured opt-in so moving cleanup does not change
      // discovery identity, while actual input changes still invalidate F06 state.
      const fingerprint = discoveryFingerprint({
        provider: { ...record.provider, headers: provider.headers, settings: provider.options },
        sourceConnection: record.sourceConnection,
      });
      if (pluginOptions?.discovery !== true || previous?.fingerprint !== fingerprint) {
        previous?.controller.abort();
        states.delete(providerID);
        previous = undefined;
      }
      if (pluginOptions?.discovery !== true) continue;
      if (previous?.result.status === "in-flight") continue;
      if (previous?.result.status === "success" && Date.now() <= previous.result.refreshAt) continue;
      if (previous?.result.status === "failure" && Date.now() < previous.result.retryAt) continue;

      const state: DiscoveryState = {
        fingerprint,
        controller: new AbortController(),
        failures: previous?.failures ?? 0,
        result: { status: "in-flight" },
      };
      previous?.controller.abort();
      states.set(providerID, state);
      const isCurrent = (): boolean => !disposed && states.get(providerID) === state;
      const fail = (): void => {
        if (!isCurrent()) return;
        state.failures += 1;
        // Retries require a later host replay, with capped exponential backoff.
        // Failure never requests reload: even other providers' success replays
        // cannot create an immediate retry/reload loop.
        state.result = { status: "failure", retryAt: Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(state.failures - 1, 6)) };
      };

      // Transforms are synchronous. Start discovery from the post-config
      // source visible here, then reload to replay this transform once the
      // discovered inventory is available. Do not register another transform.
      void (async (): Promise<void> => {
        await discoverProviderModels(providerID, provider, log, ctx.storage, { signal: state.controller.signal, fingerprint });
        if (!isCurrent()) return;
        if (!provider.models) {
          fail();
          return;
        }
        state.failures = 0;
        state.result = {
          status: "success",
          // Cache expiry is an intentional refresh boundary on a later replay.
          // A minimum interval prevents tiny TTLs from feeding reload loops.
          refreshAt: Date.now() + Math.max(1_000, parseCacheDuration(pluginOptions.discoveryCache) ?? Infinity),
          models: modelDraftsToV2(provider.models),
          enrichExistingModels: pluginOptions.enrichExistingModels === true,
        };
        await ctx.model.reload();
      })().catch((error: unknown) => {
        if (!isCurrent()) return;
        if (state.result.status === "in-flight") fail();
        console.error("[opencode-model-discovery]", error);
      });
    }

    for (const [providerID, state] of states) {
      if (state.result.status !== "success") continue;
      const { models, enrichExistingModels } = state.result;
      const provider = editor.provider.get(providerID);
      if (!provider) continue;
      for (const [modelID, discoveredModel] of models) {
        const source = provider.models.get(modelID);
        editor.update(providerID, modelID, (model) => {
          if (source) {
            // The host draft includes inherited source fields, not just user
            // config. Only differences are visible overrides; equal-value config
            // cannot be identified here. Later config transforms still win.
            const overrides = sourceModelOverrides(model, source);
            if (Object.keys(overrides).length && !enrichExistingModels) return;
            Object.assign(model, fillMissingFields(
              fillMissingFields(overrides, discoveredModel), source,
            ));
          } else {
            // Without a source, all existing raw fields are explicit earlier
            // transform edits. Fill gaps only; the host applies defaults later.
            Object.assign(model, fillMissingFields(model, discoveredModel));
          }
        });
      }
    }
    settings.reconcile(records);
  });
  return () => {
    disposed = true;
    settings.dispose();
    for (const state of states.values()) state.controller.abort();
    states.clear();
  };
};

function providerFromV2(
  info: Pick<Provider.Info, "id" | "name" | "settings" | "headers">,
  pluginOptions: NonNullable<OpenCodeProvider["options"]>["opencode-model-discovery"],
): OpenCodeProvider {
  const options = info.settings as OpenCodeProvider["options"];
  return {
    name: info.name,
    // Canonical names preserve effective last-entry precedence in the sorted
    // fingerprint, including when duplicate case variants change insertion order.
    headers: Object.fromEntries(Object.entries(info.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    // Snapshot discovery inputs without cloning unrelated callable adapter options.
    options: { ...options, "opencode-model-discovery": structuredClone(pluginOptions) },
  };
}

function modelDraftsToV2(
  models: Record<string, OpenCodeModelEntry>,
): Map<string, DiscoveredModelInfo> {
  return new Map(Object.entries(models).map(([id, entry]) => {
    return [id, { ...(runtimeDrafts.get(entry) ?? modelInfoDraft(entry)) }];
  }));
}
