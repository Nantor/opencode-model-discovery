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
 * Strip trailing "/" characters from a base URL without a regex.
 * `baseURL` is uncontrolled config data, so avoid regexes that could be
 * susceptible to ReDoS (see CWE-1333).
 */
function trimTrailingSlashes(baseURL: string): string {
  let end = baseURL.length;
  while (end > 0 && baseURL.charCodeAt(end - 1) === 0x2f /* "/" */) {
    end -= 1;
  }
  return baseURL.slice(0, end);
}

async function fetchEndpoint<T>(
  baseURL: string,
  path: string,
  apiKey?: string,
  timeoutMs = 10_000,
): Promise<T> {
  const url = `${trimTrailingSlashes(baseURL)}${path}`;
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
  const trimmed = trimTrailingSlashes(baseURL);
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

export function discoveryTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function isLiteLLMModel(value: unknown): value is LiteLLMModel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<LiteLLMModel>).id === "string"
  );
}

export function isLiteLLMModelInfoEntry(value: unknown): value is LiteLLMModelInfoEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<LiteLLMModelInfoEntry>;
  return (
    typeof entry.model_name === "string" &&
    typeof entry.litellm_params === "object" &&
    entry.litellm_params !== null &&
    typeof entry.model_info === "object" &&
    entry.model_info !== null
  );
}

/**
 * Fetch the model list from GET /v1/models?return_wildcard_routes=true.
 */
export async function fetchModels(
  baseURL: string,
  apiKey?: string,
  timeoutMs?: number,
): Promise<LiteLLMModel[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelsResponse>(
    url,
    "/v1/models?return_wildcard_routes=true",
    apiKey,
    timeoutMs,
  );
  if (!Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v1/models: missing data array`);
  }
  return json.data.filter(isLiteLLMModel);
}

/**
 * Fetch model info from GET /v2/model/info?return_wildcard_routes=true.
 * Returns entries containing `model_info` details (max_tokens, costs, feature flags, etc.)
 */
export async function fetchModelInfo(
  baseURL: string,
  apiKey?: string,
  timeoutMs?: number,
): Promise<LiteLLMModelInfoEntry[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelInfoResponse>(
    url,
    "/v2/model/info?return_wildcard_routes=true",
    apiKey,
    timeoutMs,
  );

  if (!Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v2/model/info: missing data array`);
  }

  return json.data.filter(isLiteLLMModelInfoEntry);
}
