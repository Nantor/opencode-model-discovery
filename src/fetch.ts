import type {
  LiteLLMModel,
  LiteLLMModelInfoEntry,
  LiteLLMModelsResponse,
} from "./types.js";
import { toNum } from "./types.ts";

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

/** Explicit provider headers override defaults, including bearer auth, case-insensitively. */
export function discoveryHeaders(apiKey?: string, configured?: Readonly<Record<string, string>>): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  // set (rather than constructor/append) gives duplicate case variants a single,
  // deterministic last-configured value instead of joining credentials with commas.
  for (const [name, value] of Object.entries(configured ?? {})) headers.set(name, value);
  return headers;
}

async function fetchEndpoint<T>(
  baseURL: string,
  path: string,
  apiKey?: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
  configuredHeaders?: Readonly<Record<string, string>>,
): Promise<T> {
  const url = `${trimTrailingSlashes(baseURL)}${path}`;
  const headers = discoveryHeaders(apiKey, configuredHeaders);

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

/** Validate the record shape, then independently retain usable discovery fields. */
export function sanitizeLiteLLMModelInfoEntry(value: unknown): LiteLLMModelInfoEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { model_name, litellm_params, model_info } = value;
  if (
    typeof model_name !== "string" ||
    !isRecord(litellm_params) ||
    !isRecord(model_info)
  ) return undefined;

  return sanitizeModelInfoFields({ model_name, litellm_params, model_info });
}

/** Construct typed metadata without asserting that unchecked optional fields are valid. */
export function sanitizeModelInfoFields(entry: {
  model_name: string;
  litellm_params: Record<string, unknown>;
  model_info: Record<string, unknown>;
}): LiteLLMModelInfoEntry {
  const result: LiteLLMModelInfoEntry = { model_name: entry.model_name, litellm_params: {}, model_info: {} };
  const params = entry.litellm_params;
  if (typeof params.model === "string") result.litellm_params.model = params.model;
  if (typeof params.merge_reasoning_content_in_choices === "boolean") {
    result.litellm_params.merge_reasoning_content_in_choices = params.merge_reasoning_content_in_choices;
  }
  const info = entry.model_info;
  if (typeof info.mode === "string") result.model_info.mode = info.mode;
  if (Array.isArray(info.supported_openai_params)) {
    result.model_info.supported_openai_params = info.supported_openai_params.filter(
      (param: unknown): param is string => typeof param === "string",
    );
  }
  for (const field of [
    "max_tokens", "max_input_tokens", "max_output_tokens",
    "input_cost_per_token", "output_cost_per_token",
    "cache_read_input_token_cost", "cache_creation_input_token_cost",
    "input_cost_per_token_above_200k_tokens", "output_cost_per_token_above_200k_tokens",
    "cache_read_input_token_cost_above_200k_tokens", "cache_creation_input_token_cost_above_200k_tokens",
  ] as const) {
    const value = toNum(info[field]);
    if (value !== undefined) result.model_info[field] = value;
  }
  for (const field of [
    "supports_reasoning", "reasoning", "supports_function_calling", "supports_tool_choice",
    "supports_vision", "supports_audio_input", "supports_audio_output", "supports_pdf_input",
  ] as const) {
    if (typeof info[field] === "boolean") result.model_info[field] = info[field];
  }
  return result;
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
  headers?: Readonly<Record<string, string>>,
): Promise<LiteLLMModel[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<LiteLLMModelsResponse>(
    url,
    "/v1/models?return_wildcard_routes=true",
    apiKey,
    timeoutMs,
    signal,
    headers,
  );
  if (!Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v1/models: missing data array`);
  }
  return json.data.filter(isLiteLLMModel);
}

/**
 * Fetch model info from GET /v2/model/info?return_wildcard_routes=true.
 * Returns sanitized discovery details (max_tokens, costs, feature flags, etc.)
 */
export async function fetchModelInfo(
  baseURL: string,
  apiKey?: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<LiteLLMModelInfoEntry[]> {
  const url = normalizeBaseURL(baseURL);
  const json = await fetchEndpoint<unknown>(
    url,
    "/v2/model/info?return_wildcard_routes=true",
    apiKey,
    timeoutMs,
    signal,
    headers,
  );

  if (!isRecord(json) || !Array.isArray(json.data)) {
    throw new Error(`Unexpected response from ${url}/v2/model/info: missing data array`);
  }

  return json.data.map(sanitizeLiteLLMModelInfoEntry).filter((entry) => entry !== undefined);
}
