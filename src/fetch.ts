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
  signal?: AbortSignal,
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
    const res = await fetch(url, { headers, signal: signal
      ? AbortSignal.any([signal, controller.signal]) : controller.signal });
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
  if (!isRecord(value)) return false;
  const { model_name, litellm_params, model_info } = value;
  if (
    typeof model_name !== "string" ||
    !isRecord(litellm_params) ||
    !isRecord(model_info)
  ) return false;

  // These optional fields drive string/array operations downstream. Reject only
  // the affected metadata entry; /v1/models still supplies its basic model.
  // Numeric values and capability flags are checked by their mapping helpers.
  return (
    (litellm_params.model === undefined || typeof litellm_params.model === "string") &&
    (model_info.mode === undefined || typeof model_info.mode === "string") &&
    (model_info.supported_openai_params === undefined ||
      (Array.isArray(model_info.supported_openai_params) &&
        model_info.supported_openai_params.every((param: unknown) => typeof param === "string")))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fetch the model list from GET /v1/models?return_wildcard_routes=true.
 */
export async function fetchModels(
  baseURL: string,
  apiKey?: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<LiteLLMModel[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelsResponse>(
    url,
    "/v1/models?return_wildcard_routes=true",
    apiKey,
    timeoutMs,
    signal,
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
  signal?: AbortSignal,
): Promise<LiteLLMModelInfoEntry[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelInfoResponse>(
    url,
    "/v2/model/info?return_wildcard_routes=true",
    apiKey,
    timeoutMs,
    signal,
  );

  if (!Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v2/model/info: missing data array`);
  }

  return json.data.filter(isLiteLLMModelInfoEntry);
}
