import type {
  LiteLLMModelInfo,
  LiteLLMModelInfoEntry,
  LiteLLMParams,
  OpenCodeModelCost,
  OpenCodeModelEntry,
  OpenCodeProvider,
} from "./types.js";
import { sanitizeKey, toDisplayName } from "./utils.js";
import { toNum } from "./types.js";

// ---------------------------------------------------------------------------
// Map LiteLLM models → OpenCode provider config
// ---------------------------------------------------------------------------

export function buildProviderConfig(
  modelInfoEntries: LiteLLMModelInfoEntry[],
  baseURL: string,
  apiKey?: string,
  providerName = "LiteLLM",
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

  for (const entry of modelInfoEntries) {
    const id = entry.model_name;
    const key = sanitizeKey(id);
    // Look up model info and params by original id and sanitized key
    const info = infoMap.get(id) ?? infoMap.get(key);
    const params = paramsMap.get(id) ?? paramsMap.get(key);
    const modelEntry: OpenCodeModelEntry = {
      ...(key !== id ? { id } : {}),
    };

    if (info) {
      // --- limit (context window / token counts) ---
      const contextTokens = toNum(info.max_tokens);
      const inputTokens = toNum(info.max_input_tokens);
      const outputTokens = toNum(info.max_output_tokens);

      if (contextTokens !== undefined && outputTokens !== undefined) {
        const limit: { context: number; output: number; input?: number } = { context: contextTokens, output: outputTokens };
        if (inputTokens !== undefined) {
          limit.input = inputTokens;
        }
        modelEntry.limit = limit;
      }

      // --- cost (per-token pricing in USD) ---
      const inputCost = toNum(info.input_cost_per_token) !== undefined ? toNum(info.input_cost_per_token!)! * 1_000_000 : undefined;
      const outputCost = toNum(info.output_cost_per_token) !== undefined ? toNum(info.output_cost_per_token!)! * 1_000_000 : undefined;

      if (inputCost !== undefined && outputCost !== undefined) {
        const cost: OpenCodeModelCost = { input: inputCost, output: outputCost };

        if (toNum(info.cache_read_input_token_cost) !== undefined) {
          cost.cache_read = toNum(info.cache_read_input_token_cost!)! * 1_000_000;
        }
        if (toNum(info.cache_creation_input_token_cost) !== undefined) {
          cost.cache_write = toNum(info.cache_creation_input_token_cost!)! * 1_000_000;
        }

        // context_over_200k pricing tiers
        const inputOver200k = toNum(info.input_cost_per_token_above_200k_tokens);
        const outputOver200k = toNum(info.output_cost_per_token_above_200k_tokens);
        if (inputOver200k !== undefined && outputOver200k !== undefined) {
          cost.context_over_200k = { input: inputOver200k * 1_000_000, output: outputOver200k * 1_000_000 };
          if (toNum(info.cache_read_input_token_cost_above_200k_tokens) !== undefined) {
            cost.context_over_200k.cache_read = toNum(info.cache_read_input_token_cost_above_200k_tokens!)! * 1_000_000;
          }
          if (toNum(info.cache_creation_input_token_cost_above_200k_tokens) !== undefined) {
            cost.context_over_200k.cache_write = toNum(info.cache_creation_input_token_cost_above_200k_tokens!)! * 1_000_000;
          }
        }

        modelEntry.cost = cost;
      }

      // --- reasoning ---
      if (typeof info.supports_reasoning === "boolean" && info.supports_reasoning) {
        modelEntry.reasoning = true;
      } else if (typeof info.reasoning === "boolean" && info.reasoning) {
        modelEntry.reasoning = true;
      }

      // --- tool_call ---
      if (info.supports_function_calling === true || info.supports_tool_choice === true) {
        modelEntry.tool_call = true;
      }

      // --- attachment (vision / image input) ---
      if (info.supports_vision === true) {
        modelEntry.attachment = true;
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
        modelEntry.modalities = { input: inputModalities, output: outputModalities };
      }
    }

    // --- reasoningSummary workaround ---
    // OpenCode (via @ai-sdk/openai-compatible) sends `reasoningSummary` for
    // reasoning models. LiteLLM stable (≤1.86.x) forwards it verbatim to the
    // upstream provider, which rejects it with "Unknown parameter: reasoningSummary".
    // Setting `options.reasoningSummary: null` at the model level tells the AI SDK
    // to omit the field entirely, preventing the 400 error when you cannot change
    // the LiteLLM config yourself.
    if (modelEntry.reasoning === true) {
      modelEntry.options = { ...modelEntry.options, reasoningSummary: null };
    }

    // --- interleaved reasoning tokens ---
    // When merge_reasoning_content_in_choices is true, the provider streams
    // reasoning tokens interleaved in the choices[].message.reasoning_content field.
    // This check is independent of model info — params alone is sufficient.
    if (params?.merge_reasoning_content_in_choices === true) {
      modelEntry.interleaved = { field: "reasoning_content" };
    }

    if (key in modelsMap) {
      console.warn(
        `[litellm-to-opencode] Duplicate model key "${key}" (from id "${id}") — previous entry overwritten.`,
      );
    }
    modelEntry.name = toDisplayName(id, modelEntry.cost, modelEntry.limit);
    modelsMap[key] = modelEntry;
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
