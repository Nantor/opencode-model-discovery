import type { Plugin } from "@opencode-ai/plugin";

import { fetchModelInfo, fetchModels } from "./fetch.js";
import { buildProviderConfig } from "./provider.js";
import type {
  LiteLLMModelInfoEntry,
  OpenCodeConfig,
  OpenCodeProvider,
} from "./types.js";

type Logger = (level: "info" | "warn" | "error", message: string) => Promise<void>;

function entriesForModels(
  modelIDs: string[],
  infoEntries: LiteLLMModelInfoEntry[],
): LiteLLMModelInfoEntry[] {
  const byID = new Map<string, LiteLLMModelInfoEntry>();
  for (const entry of infoEntries) {
    byID.set(entry.model_name, entry);
    if (entry.litellm_params.model) {
      byID.set(entry.litellm_params.model, entry);
    }
  }

  return modelIDs.map((id) => {
    const info = byID.get(id);
    return info
      ? { ...info, model_name: id }
      : { model_name: id, litellm_params: { model: id }, model_info: {} };
  });
}

export async function discoverProviderModels(
  providerID: string,
  provider: OpenCodeProvider,
  log?: Logger,
): Promise<void> {
  const options = provider.options;
  if (options?.discovery !== true) return;

  const { discovery: _discovery, modelNameFormat, ...adapterOptions } = options;
  provider.options = adapterOptions;

  if (!options.baseURL) {
    await log?.("warn", `Provider "${providerID}" has discovery enabled but no baseURL`);
    return;
  }

  try {
    const models = await fetchModels(options.baseURL, options.apiKey);
    let infoEntries: LiteLLMModelInfoEntry[] = [];
    try {
      infoEntries = await fetchModelInfo(options.baseURL, options.apiKey);
    } catch (error) {
      await log?.(
        "warn",
        `Could not fetch detailed model info for "${providerID}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const discovered = buildProviderConfig(
      entriesForModels(models.map((model) => model.id), infoEntries),
      options.baseURL,
      options.apiKey,
      provider.name ?? providerID,
      false,
      typeof modelNameFormat === "string" ? modelNameFormat : undefined,
      providerID,
    );

    provider.models = {
      ...discovered.models,
      ...provider.models,
    };
    await log?.("info", `Discovered ${models.length} model(s) for provider "${providerID}"`);
  } catch (error) {
    await log?.(
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
