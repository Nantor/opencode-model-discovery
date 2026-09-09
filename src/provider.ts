import type {
  LiteLLMModelInfo,
  LiteLLMModelInfoEntry,
  LiteLLMParams,
  OpenCodeModelCost,
  OpenCodeModelEntry,
  OpenCodeProvider,
  Logger,
} from "./types.js";
import { normalizeBaseURL } from "./fetch.js";
import { sortByKey, toDisplayName } from "./utils.js";
import { toNum } from "./types.js";

// ---------------------------------------------------------------------------
// Map LiteLLM models → OpenCode provider config
// ---------------------------------------------------------------------------

function formatModelName(
  format: string,
  model: OpenCodeModelEntry,
  providerID: string,
): string {
  const values: Record<string, unknown> = { ...model, provider: providerID };

  return format.replace(/\{([^{}]+)\}/g, (_placeholder, content: string) => {
    if (content.startsWith("?")) {
      return formatConditional(content.slice(1), values);
    }
    return formatValue(resolvePath(content, values), content);
  });
}

function formatConditional(
  condition: string,
  values: Record<string, unknown>,
): string {
  const separatorIndex = condition.indexOf(":");
  if (separatorIndex === -1) return "";

  const pathsPart = condition.slice(0, separatorIndex);
  const bodyPart = condition.slice(separatorIndex + 1);
  const bodyMatch = /^'((?:\\'|[^'])*)'$/.exec(bodyPart);
  if (!bodyMatch) return "";

  const hasAnd = pathsPart.includes("&");
  const hasOr = pathsPart.includes("|");
  if (hasAnd && hasOr) return "";

  const paths = pathsPart.split(hasAnd ? "&" : "|").map((path) => path.trim());
  if (paths.some((path) => path === "")) return "";

  const resolvedValues = paths.map((path) => resolvePath(path, values));
  const shouldRender = hasAnd
    ? resolvedValues.every(Boolean)
    : resolvedValues.some(Boolean);
  if (!shouldRender) return "";

  return bodyMatch[1]
    .replace(/\\'/g, "'")
    .replace(/\$(\d+)/g, (_match, index: string) => {
      const numericIndex = Number(index);
      const value = resolvedValues[numericIndex];
      return value ? formatValue(value, paths[numericIndex]) : "";
    });
}

function resolvePath(path: string, values: Record<string, unknown>): unknown {
  let value: unknown = values;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null || !(segment in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function formatValue(value: unknown, path: string): string {
  if (value === undefined) return "";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  if (typeof value === "number") {
    if (path.startsWith("limit.")) return formatCompactNumber(value);
    if (path.startsWith("cost.")) return value.toFixed(2);
  }
  return String(value);
}

function formatCompactNumber(value: number): string {
  const suffixes = ["", "K", "M", "B", "T"];
  let scaled = value;
  let suffixIndex = 0;
  while (Math.abs(scaled) >= 1000 && suffixIndex < suffixes.length - 1) {
    scaled /= 1000;
    suffixIndex++;
  }
  return Number(scaled.toPrecision(3)).toString() + suffixes[suffixIndex];
}

export function buildProviderConfig(
  modelInfoEntries: LiteLLMModelInfoEntry[],
  baseURL: string,
  apiKey?: string,
  providerName = "LiteLLM",
  applyReasoningSummaryWorkaround = true,
  modelNameFormat?: string,
  providerID = "litellm",
  log?: Logger,
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
    const key = id;
    const info = infoMap.get(id);
    const params = paramsMap.get(id);
    const modelEntry: OpenCodeModelEntry = {
      name: "",
    };

    if (info) {
      // --- limit (context window / token counts) ---
      const contextTokens = toNum(info.max_tokens);
      const inputTokens = toNum(info.max_input_tokens);
      const outputTokens = toNum(info.max_output_tokens);

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

      // --- cost (per-token pricing in USD) ---
      const inputCost =
        toNum(info.input_cost_per_token) !== undefined
          ? toNum(info.input_cost_per_token!)! * 1_000_000
          : undefined;
      const outputCost =
        toNum(info.output_cost_per_token) !== undefined
          ? toNum(info.output_cost_per_token!)! * 1_000_000
          : undefined;

      if (inputCost !== undefined && outputCost !== undefined) {
        const cost: OpenCodeModelCost = {
          input: inputCost,
          output: outputCost,
        };

        if (toNum(info.cache_read_input_token_cost) !== undefined) {
          cost.cache_read =
            toNum(info.cache_read_input_token_cost!)! * 1_000_000;
        }
        if (toNum(info.cache_creation_input_token_cost) !== undefined) {
          cost.cache_write =
            toNum(info.cache_creation_input_token_cost!)! * 1_000_000;
        }

        // context_over_200k pricing tiers
        const inputOver200k = toNum(
          info.input_cost_per_token_above_200k_tokens,
        );
        const outputOver200k = toNum(
          info.output_cost_per_token_above_200k_tokens,
        );
        if (inputOver200k !== undefined && outputOver200k !== undefined) {
          cost.context_over_200k = {
            input: inputOver200k * 1_000_000,
            output: outputOver200k * 1_000_000,
          };
          if (
            toNum(info.cache_read_input_token_cost_above_200k_tokens) !==
            undefined
          ) {
            cost.context_over_200k.cache_read =
              toNum(info.cache_read_input_token_cost_above_200k_tokens!)! *
              1_000_000;
          }
          if (
            toNum(info.cache_creation_input_token_cost_above_200k_tokens) !==
            undefined
          ) {
            cost.context_over_200k.cache_write =
              toNum(info.cache_creation_input_token_cost_above_200k_tokens!)! *
              1_000_000;
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

    if (Object.hasOwn(modelsMap, key)) {
      try {
        const result = log?.(
          "warn",
          `[opencode-model-discovery] Duplicate model key "${key}" (from id "${id}") - previous entry overwritten.`,
        );
        if (result) void Promise.resolve(result).catch(() => undefined);
      } catch {
        // Logging must never prevent provider initialization.
      }
    }
    const normalizedName = toDisplayName(id);
    const formatValues: OpenCodeModelEntry = {
      ...modelEntry,
      id,
      name: normalizedName,
    };
    modelEntry.name = modelNameFormat !== undefined
      ? formatModelName(modelNameFormat, formatValues, providerID)
      : normalizedName;
    modelsMap[key] = modelEntry;
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
