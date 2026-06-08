import type {
  LiteLLMModelInfoEntry,
  LiteLLMModelInfoResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch model info from GET /v1/model/info.
 * Returns entries containing `model_info` details (max_tokens, costs, feature flags, etc.)
 */
export async function fetchModelInfo(
  baseURL: string,
  apiKey?: string,
): Promise<LiteLLMModelInfoEntry[]> {
  const url = `${baseURL.replace(/\/$/, "")}/v1/model/info`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  console.log(`Fetching model info from ${url} …`);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.warn(
      `Warning: HTTP ${res.status} fetching /v1/model/info from ${url}. Skipping model info.`,
    );
    return [];
  }

  const json = (await res.json()) as LiteLLMModelInfoResponse;

  if (!Array.isArray(json.data)) {
    console.warn(
      `Warning: Unexpected response shape from ${url}, missing "data" array. Skipping model info.`,
    );
    return [];
  }

  return json.data;
}


