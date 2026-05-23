import type {
  LiteLLMModel,
  LiteLLMModelInfo,
  LiteLLMModelInfoEntry,
  LiteLLMParams,
  OpenCodeModelCost,
  OpenCodeModelEntry,
  OpenCodeProvider,
} from "./types.js";
import { sanitizeKey, toDisplayName } from "./utils.js";

// ---------------------------------------------------------------------------
// Map LiteLLM models → OpenCode provider config
// ---------------------------------------------------------------------------

export function buildProviderConfig(
  models: LiteLLMModel[],
  baseURL: string,
  apiKey?: string,
  providerName = "LiteLLM",
  modelInfoEntries: LiteLLMModelInfoEntry[] = [],
): OpenCodeProvider {
  // Build lookups from model_name → model_info and model_name → litellm_params
  const infoMap = new Map<string, LiteLLMModelInfo>();
  const paramsMap = new Map<string, LiteLLMParams>();
  for (const entry of modelInfoEntries) {
    infoMap.set(entry.model_name, entry.model_info);
    paramsMap.set(entry.model_name, entry.litellm_params);
    // Also index by litellm_params.model if it differs and the key is not
    // already present — avoids silently overwriting the primary model_name entry
    // when both keys happen to be equal or collide after sanitisation.
    if (entry.litellm_params?.model && !infoMap.has(entry.litellm_params.model)) {
      infoMap.set(entry.litellm_params.model, entry.model_info);
      paramsMap.set(entry.litellm_params.model, entry.litellm_params);
    }
  }

  const modelsMap: Record<string, OpenCodeModelEntry> = {};

  for (const m of models) {
    const key = sanitizeKey(m.id);
    // Look up model info and params by original id and sanitized key
    const info = infoMap.get(m.id) ?? infoMap.get(key);
    const params = paramsMap.get(m.id) ?? paramsMap.get(key);

    const entry: OpenCodeModelEntry = {
      name: toDisplayName(m.id),
      ...(key !== m.id ? { id: m.id } : {}),
    };

    if (info) {
      // --- limit (context window / token counts) ---
      // prefer max_input_tokens for context; fall back to max_tokens
      const contextTokens =
        typeof info.max_input_tokens === "number"
          ? info.max_input_tokens
          : typeof info.max_tokens === "number"
            ? info.max_tokens
            : undefined;
      const outputTokens =
        typeof info.max_output_tokens === "number" ? info.max_output_tokens : undefined;

      if (contextTokens !== undefined && outputTokens !== undefined) {
        entry.limit = { context: contextTokens, output: outputTokens };
      }

      // --- cost (per-token pricing in USD) ---
      const inputCost =
        typeof info.input_cost_per_token === "number" ? info.input_cost_per_token : undefined;
      const outputCost =
        typeof info.output_cost_per_token === "number" ? info.output_cost_per_token : undefined;

      if (inputCost !== undefined && outputCost !== undefined) {
        const cost: OpenCodeModelCost = { input: inputCost, output: outputCost };

        if (typeof info.cache_read_input_token_cost === "number") {
          cost.cache_read = info.cache_read_input_token_cost;
        }
        if (typeof info.cache_creation_input_token_cost === "number") {
          cost.cache_write = info.cache_creation_input_token_cost;
        }

        // context_over_200k pricing tiers
        const inputOver200k =
          typeof info.input_cost_per_token_above_200k_tokens === "number"
            ? info.input_cost_per_token_above_200k_tokens
            : undefined;
        const outputOver200k =
          typeof info.output_cost_per_token_above_200k_tokens === "number"
            ? info.output_cost_per_token_above_200k_tokens
            : undefined;
        if (inputOver200k !== undefined && outputOver200k !== undefined) {
          cost.context_over_200k = { input: inputOver200k, output: outputOver200k };
          if (typeof info.cache_read_input_token_cost_above_200k_tokens === "number") {
            cost.context_over_200k.cache_read = info.cache_read_input_token_cost_above_200k_tokens;
          }
          if (typeof info.cache_creation_input_token_cost_above_200k_tokens === "number") {
            cost.context_over_200k.cache_write = info.cache_creation_input_token_cost_above_200k_tokens;
          }
        }

        entry.cost = cost;
      }

      // --- reasoning ---
      if (typeof info.supports_reasoning === "boolean" && info.supports_reasoning) {
        entry.reasoning = true;
      } else if (typeof info.reasoning === "boolean" && info.reasoning) {
        entry.reasoning = true;
      }

      // --- tool_call ---
      if (info.supports_function_calling === true || info.supports_tool_choice === true) {
        entry.tool_call = true;
      }

      // --- attachment (vision / image input) ---
      if (info.supports_vision === true) {
        entry.attachment = true;
      }

      // --- modalities ---
      const inputModalities: Array<"text" | "audio" | "image" | "video" | "pdf"> = ["text"];
      if (info.supports_vision === true) inputModalities.push("image");
      if (info.supports_audio_input === true) inputModalities.push("audio");
      if (info.supports_pdf_input === true) inputModalities.push("pdf");

      const outputModalities: Array<"text" | "audio" | "image" | "video" | "pdf"> = ["text"];
      if (info.supports_audio_output === true) outputModalities.push("audio");

      // Only set modalities when we have something beyond the plain text default
      if (inputModalities.length > 1 || outputModalities.length > 1) {
        entry.modalities = { input: inputModalities, output: outputModalities };
      }
    }

    // --- interleaved reasoning tokens ---
    // When merge_reasoning_content_in_choices is true, the provider streams
    // reasoning tokens interleaved in the choices[].message.reasoning_content field.
    // This check is independent of model info — params alone is sufficient.
    if (params?.merge_reasoning_content_in_choices === true) {
      entry.interleaved = { field: "reasoning_content" };
    }

    if (key in modelsMap) {
      console.warn(
        `[litellm-to-opencode] Duplicate model key "${key}" (from id "${m.id}") — previous entry overwritten.`,
      );
    }
    modelsMap[key] = entry;
  }

  const provider: OpenCodeProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: providerName,
    options: {
      baseURL: `${baseURL.replace(/\/$/, "")}/v1`,
      ...(apiKey ? { apiKey } : {}),
    },
    models: modelsMap,
  };

  return provider;
}
