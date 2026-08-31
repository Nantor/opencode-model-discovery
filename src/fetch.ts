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
): Promise<T> {
  const url = `${baseURL.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return (await res.json()) as T;
}

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function fetchModels(
  baseURL: string,
  apiKey?: string,
): Promise<LiteLLMModel[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelsResponse>(url, "/v1/models", apiKey);
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
): Promise<LiteLLMModelInfoEntry[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelInfoResponse>(
    url,
    "/v1/model/info",
    apiKey,
  );

  if (!Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v1/model/info: missing data array`);
  }

  return json.data;
}
