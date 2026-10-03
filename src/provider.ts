import type {
  LiteLLMModelInfo,
  LiteLLMModelInfoEntry,
  LiteLLMParams,
  OpenCodeModelCost,
  OpenCodeModelEntry,
  OpenCodeProvider,
} from "./types.js";
import { normalizeBaseURL } from "./fetch.js";
import { sortByKey, toDisplayName } from "./utils.js";
import { toNum } from "./types.js";

// ---------------------------------------------------------------------------
// Map LiteLLM models → OpenCode provider config
// ---------------------------------------------------------------------------

function toPerMillion(perToken: unknown): number | undefined {
  const value = toNum(perToken);
  return value === undefined ? undefined : value * 1_000_000;
}

export function buildProviderConfig(
  modelInfoEntries: LiteLLMModelInfoEntry[],
  baseURL: string,
  apiKey?: string,
  providerName = "LiteLLM",
  applyReasoningSummaryWorkaround = true,
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
    if (
      entry.litellm_params?.model &&
      !infoMap.has(entry.litellm_params.model)
    ) {
      infoMap.set(entry.litellm_params.model, entry.model_info);
      paramsMap.set(entry.litellm_params.model, entry.litellm_params);
    }
  }

  const modelsMap: Record<string, OpenCodeModelEntry> = Object.create(null) as Record<
    string,
    OpenCodeModelEntry
  >;

  for (const entry of modelInfoEntries) {
    const id = entry.model_name;
    const info = infoMap.get(id);
    const params = paramsMap.get(id);
    const modelEntry: OpenCodeModelEntry = {
      name: "",
    };

    if (info) {
      // --- limit (context window / token counts) ---
      // LiteLLM's `max_tokens` is a legacy alias for `max_output_tokens`, not
      // the context window. The context window is `max_input_tokens`; fall
      // back to `max_tokens` only when LiteLLM did not report an input limit.
      const inputTokens = toNum(info.max_input_tokens);
      const outputTokens = toNum(info.max_output_tokens) ?? toNum(info.max_tokens);
      const contextTokens = inputTokens ?? toNum(info.max_tokens);

      if (contextTokens !== undefined && outputTokens !== undefined) {
        const limit: { context: number; output: number; input?: number } = {
          context: contextTokens,
          output: outputTokens,
        };
        if (inputTokens !== undefined) {
          limit.input = inputTokens;
        }
        modelEntry.limit = limit;
      }

      // --- cost (LiteLLM reports USD per token; OpenCode expects USD per 1M tokens) ---
      const inputCost = toPerMillion(info.input_cost_per_token);
      const outputCost = toPerMillion(info.output_cost_per_token);

      if (inputCost !== undefined && outputCost !== undefined) {
        const cost: OpenCodeModelCost = {
          input: inputCost,
          output: outputCost,
        };

        const cacheRead = toPerMillion(info.cache_read_input_token_cost);
        if (cacheRead !== undefined) cost.cache_read = cacheRead;
        const cacheWrite = toPerMillion(info.cache_creation_input_token_cost);
        if (cacheWrite !== undefined) cost.cache_write = cacheWrite;

        // context_over_200k pricing tiers
        const inputOver200k = toPerMillion(info.input_cost_per_token_above_200k_tokens);
        const outputOver200k = toPerMillion(info.output_cost_per_token_above_200k_tokens);
        if (inputOver200k !== undefined && outputOver200k !== undefined) {
          cost.context_over_200k = {
            input: inputOver200k,
            output: outputOver200k,
          };
          const cacheReadOver200k = toPerMillion(info.cache_read_input_token_cost_above_200k_tokens);
          if (cacheReadOver200k !== undefined) {
            cost.context_over_200k.cache_read = cacheReadOver200k;
          }
          const cacheWriteOver200k = toPerMillion(info.cache_creation_input_token_cost_above_200k_tokens);
          if (cacheWriteOver200k !== undefined) {
            cost.context_over_200k.cache_write = cacheWriteOver200k;
          }
        }

        modelEntry.cost = cost;
      }

      // --- reasoning ---
      if (
        typeof info.supports_reasoning === "boolean" &&
        info.supports_reasoning
      ) {
        modelEntry.reasoning = true;
      } else if (typeof info.reasoning === "boolean" && info.reasoning) {
        modelEntry.reasoning = true;
      }

      // --- tool_call ---
      if (
        info.supports_function_calling === true ||
        info.supports_tool_choice === true
      ) {
        modelEntry.tool_call = true;
      }

      // --- attachment (vision / image input) ---
      if (info.supports_vision === true) {
        modelEntry.attachment = true;
      }

      // --- modalities ---
      const inputModalities: Array<
        "text" | "audio" | "image" | "video" | "pdf"
      > = ["text"];
      if (info.supports_vision === true) inputModalities.push("image");
      if (info.supports_audio_input === true) inputModalities.push("audio");
      if (info.supports_pdf_input === true) inputModalities.push("pdf");

      const outputModalities: Array<
        "text" | "audio" | "image" | "video" | "pdf"
      > = ["text"];
      if (info.supports_audio_output === true) outputModalities.push("audio");

      // Only set modalities when we have something beyond the plain text default
      if (inputModalities.length > 1 || outputModalities.length > 1) {
        modelEntry.modalities = {
          input: inputModalities,
          output: outputModalities,
        };
      }
    }

    // --- reasoningSummary workaround ---
    // OpenCode (via @ai-sdk/openai-compatible) sends `reasoningSummary` for
    // reasoning models. LiteLLM stable (≤1.86.x) forwards it verbatim to the
    // upstream provider, which rejects it with "Unknown parameter: reasoningSummary".
    // Setting `options.reasoningSummary: null` at the model level tells the AI SDK
    // to omit the field entirely, preventing the 400 error when you cannot change
    // the LiteLLM config yourself.
    if (applyReasoningSummaryWorkaround && modelEntry.reasoning === true) {
      modelEntry.options = { ...modelEntry.options, reasoningSummary: null };
    }

    // --- interleaved reasoning tokens ---
    // When merge_reasoning_content_in_choices is true, the provider streams
    // reasoning tokens interleaved in the choices[].message.reasoning_content field.
    // This check is independent of model info — params alone is sufficient.
    if (params?.merge_reasoning_content_in_choices === true) {
      modelEntry.interleaved = { field: "reasoning_content" };
    }

    modelEntry.name = toDisplayName(id);
    modelsMap[id] = modelEntry;
  }

  const provider: OpenCodeProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: providerName,
    options: {
      baseURL: `${normalizeBaseURL(baseURL)}/v1`,
      ...(apiKey ? { apiKey } : {}),
    },
    models: sortByKey(modelsMap, "name"),
  };

  return provider;
}
