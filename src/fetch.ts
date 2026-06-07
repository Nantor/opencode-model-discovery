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

export async function fetchModels(
  baseURL: string,
  apiKey?: string,
): Promise<LiteLLMModel[]> {
  const url = `${baseURL.replace(/\/$/, "")}/v1/models`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  console.log(`Fetching models from ${url} …`);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }

  const json = (await res.json()) as LiteLLMModelsResponse;

  if (!Array.isArray(json.data)) {
    throw new Error(
      `Unexpected response shape: missing "data" array.\n${JSON.stringify(json, null, 2)}`,
    );
  }

  return json.data;
}

/**
 * Test that a model is available by sending a minimal chat completion request.
 * Returns { ok: true } on success or { ok: false, error: string } on failure.
 */
export async function testModel(
  baseURL: string,
  modelId: string,
  apiKey?: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${baseURL.replace(/\/$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "just return hi" }],
      }),
    });

    if (res.ok || res.status === 200) {
      return { ok: true };
    }

    let errorMsg: string;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      errorMsg = errBody.error?.message ?? `HTTP ${res.status}`;
    } catch {
      errorMsg = `HTTP ${res.status} ${res.statusText}`;
    }

    return { ok: false, error: errorMsg };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
