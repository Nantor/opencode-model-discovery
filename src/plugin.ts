import type { Plugin } from "@opencode-ai/plugin";

import { fetchModelInfo, fetchModels } from "./fetch.js";
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
    // A wildcard route id (e.g. "claude-opus-4-5*") matches an info entry;
    // key the model by its resolved litellm_params.model so the asterisk is
    // not carried into the config.
    if (info.model_name.endsWith("*") && info.litellm_params.model) {
      return { ...info, model_name: info.litellm_params.model };
    }
    return { ...info, model_name: id };
  });

  // Wildcard routes (e.g. "claude-opus-4-5*") reported by
  // return_wildcard_routes=true expose their real id only via
  // litellm_params.model. Ensure each is present under that key so the
  // claude (and other wildcard) models surface in the config even if
  // /v1/models does not list them under a usable id.
  const known = new Set(modelIDs);
  const wildcardTargets = new Set<string>();
  for (const entry of infoEntries) {
    if (!entry.model_name.endsWith("*")) continue;
    const target = entry.litellm_params.model;
    if (!target || known.has(target) || wildcardTargets.has(target)) continue;
    wildcardTargets.add(target);
    resolved.push({ ...entry, model_name: target, litellm_params: entry.litellm_params });
  }

  return resolved;
}

function usesMaxCompletionTokens(entry: LiteLLMModelInfoEntry): boolean {
  const parameters = entry.model_info.supported_openai_params;
  return (
    parameters?.includes("max_completion_tokens") === true &&
    !parameters.includes("max_tokens")
  );
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
  if (options?.discovery !== true) return;

  const {
    discovery: _discovery,
    discoveryTimeout: _discoveryTimeout,
    modelNameFormat,
    ...adapterOptions
  } = options;
  provider.options = adapterOptions;

  if (!options.baseURL) {
    await safeLog(log, "warn", `Provider "${providerID}" has discovery enabled but no baseURL`);
    return;
  }

  const timeoutMs =
    typeof options.discoveryTimeout === "number" &&
    Number.isFinite(options.discoveryTimeout) &&
    options.discoveryTimeout >= 0
      ? options.discoveryTimeout
      : undefined;

  try {
    const models = await fetchModels(options.baseURL, options.apiKey, timeoutMs);
    let infoEntries: LiteLLMModelInfoEntry[] = [];
    try {
      infoEntries = await fetchModelInfo(options.baseURL, options.apiKey, timeoutMs);
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
    );
    const discovered = buildProviderConfig(
      discoveredEntries,
      options.baseURL,
      options.apiKey,
      provider.name ?? providerID,
      false,
      typeof modelNameFormat === "string" ? modelNameFormat : undefined,
      providerID,
      log,
    );

    provider.models = {
      ...discovered.models,
      ...provider.models,
    };
    addMaxCompletionTokensTransform(provider, discoveredEntries);
    await safeLog(log, "info", `Discovered ${models.length} model(s) for provider "${providerID}"`);
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
