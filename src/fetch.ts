import type {
  LiteLLMModel,
  LiteLLMModelInfoEntry,
  LiteLLMModelInfoResponse,
  LiteLLMModelsResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch model info from GET /v1/model/info.
 * Returns entries containing `model_info` details (max_tokens, costs, feature flags, etc.)
 */
async function fetchEndpoint<T>(
  baseURL: string,
  path: string,
  apiKey?: string,
  timeoutMs = 10_000,
): Promise<T> {
  const url = `${baseURL.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function fetchModels(
  baseURL: string,
  apiKey?: string,
  timeoutMs?: number,
): Promise<LiteLLMModel[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelsResponse>(
    url,
    "/v1/models",
    apiKey,
    timeoutMs,
  );
  if (!Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v1/models: missing data array`);
  }
  return json.data.filter(
    (model): model is LiteLLMModel =>
      typeof model === "object" && model !== null && typeof model.id === "string",
  );
}

export async function fetchModelInfo(
  baseURL: string,
  apiKey?: string,
  timeoutMs?: number,
): Promise<LiteLLMModelInfoEntry[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelInfoResponse>(
    url,
    "/v1/model/info",
    apiKey,
    timeoutMs,
  );

  if (!Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v1/model/info: missing data array`);
  }

  return json.data.filter(
    (entry): entry is LiteLLMModelInfoEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.model_name === "string" &&
      typeof entry.litellm_params === "object" &&
      entry.litellm_params !== null &&
      typeof entry.model_info === "object" &&
      entry.model_info !== null,
  );
}
