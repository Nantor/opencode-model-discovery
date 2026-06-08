// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiteLLMModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

/** Coerce a value to number, returning undefined if it's not a valid number. */
export function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}



export type LiteLLMModelInfo = {
  id?: string;
  db_model?: boolean;
  cache_creation_input_token_cost?: number | string;
  cache_creation_input_token_cost_above_1hr?: number | string;
  cache_read_input_token_cost?: number | string;
  input_cost_per_token?: unknown | number | string;
  output_cost_per_token?: number | string;
  key?: string;
  max_tokens?: number | string;
  max_input_tokens?: number | string;
  max_output_tokens?: number | string;
  input_cost_per_token_flex?: unknown | number | string;
  input_cost_per_token_priority?: number | string;
  cache_creation_input_token_cost_above_200k_tokens?: number | string;
  cache_read_input_token_cost_above_200k_tokens?: number | string;
  cache_read_input_token_cost_above_272k_tokens?: number | string;
  cache_read_input_token_cost_flex?: unknown;
  cache_read_input_token_cost_priority?: number | string;
  input_cost_per_character?: unknown;
  input_cost_per_token_above_128k_tokens?: unknown | number | string;
  input_cost_per_token_above_200k_tokens?: number | string;
  input_cost_per_token_above_272k_tokens?: number | string;
  input_cost_per_query?: unknown;
  input_cost_per_second?: unknown;
  input_cost_per_audio_token?: number | string;
  input_cost_per_image_token?: unknown;
  input_cost_per_image?: unknown;
  input_cost_per_audio_per_second?: unknown;
  input_cost_per_video_per_second?: unknown;
  input_cost_per_token_batches?: number | string;
  output_cost_per_token_batches?: number | string;
  output_cost_per_token_flex?: unknown;
  output_cost_per_token_priority?: number | string;
  output_cost_per_audio_token?: unknown;
  output_cost_per_character?: unknown;
  output_cost_per_reasoning_token?: number | string;
  output_cost_per_token_above_128k_tokens?: unknown;
  output_cost_per_character_above_128k_tokens?: unknown;
  output_cost_per_token_above_200k_tokens?: number | string;
  output_cost_per_token_above_272k_tokens?: number | string;
  output_cost_per_second?: unknown;
  output_cost_per_second_1080p?: unknown;
  output_cost_per_video_per_second?: unknown;
  output_cost_per_image?: number | string;
  output_cost_per_image_token?: unknown;
  output_vector_size?: number | string;
  citation_cost_per_token?: unknown;
  tiered_pricing?: unknown;
  litellm_provider?: string;
  mode?: string;
  supports_system_messages?: boolean;
  supports_response_schema?: boolean;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_tool_choice?: boolean;
  supports_assistant_prefill?: boolean;
  supports_prompt_caching?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_pdf_input?: boolean;
  supports_embedding_image_input?: unknown;
  supports_native_streaming?: boolean;
  supports_native_structured_output?: boolean;
  supports_web_search?: boolean;
  supports_url_context?: boolean;
  supports_reasoning?: boolean;
  supports_none_reasoning_effort?: boolean;
  supports_minimal_reasoning_effort?: boolean;
  supports_low_reasoning_effort?: unknown;
  supports_xhigh_reasoning_effort?: boolean;
  supports_max_reasoning_effort?: boolean;
  supports_computer_use?: boolean;
  search_context_cost_per_query?: Record<string, unknown>;
  tpm?: unknown;
  rpm?: unknown;
  ocr_cost_per_page?: unknown;
  annotation_cost_per_page?: unknown;
  provider_specific_entry?: unknown;
  uses_embed_content?: unknown;
  supported_openai_params?: string[];
  updated_at?: unknown;
  updated_by?: unknown;
  created_at?: unknown;
  created_by?: unknown;
  base_model?: unknown;
  tier?: unknown;
  team_id?: unknown;
  team_public_model_name?: unknown;
  reasoning?: boolean;
};

export interface LiteLLMParams {
  vertex_project?: string;
  vertex_location?: string;
  use_in_pass_through?: boolean;
  use_litellm_proxy?: boolean;
  merge_reasoning_content_in_choices?: boolean;
  model?: string;
  api_base?: string;
  api_version?: string;
  custom_llm_provider?: string;
  aws_region_name?: string;
  encoding_format?: string;
  allowed_openai_params?: string[];
  base_model?: string;
  drop_params?: boolean;
  [key: string]: unknown;
}

export interface LiteLLMModelInfoEntry {
  model_name: string;
  litellm_params: LiteLLMParams;
  model_info: LiteLLMModelInfo;
}

export interface LiteLLMModelInfoResponse {
  data: LiteLLMModelInfoEntry[];
}

export interface LiteLLMModelsResponse {
  object: string;
  data: LiteLLMModel[];
}

export interface OpenCodeModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
}

export interface OpenCodeModelLimit {
  context: number;
  output: number;
  input?: number;
}

export interface OpenCodeModelModalities {
  input: Array<"text" | "audio" | "image" | "video" | "pdf">;
  output: Array<"text" | "audio" | "image" | "video" | "pdf">;
}

export interface OpenCodeModelEntry {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?: boolean | { field: "reasoning_content" | "reasoning_details" };
  cost?: OpenCodeModelCost;
  limit?: OpenCodeModelLimit;
  modalities?: OpenCodeModelModalities;
  experimental?: boolean;
  status?: "alpha" | "beta" | "deprecated" | "active";
  provider?: { npm?: string; api?: string };
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
  variants?: Record<string, { disabled?: boolean }>;
}

export interface OpenCodeProvider {
  npm?: string;
  name?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
    [key: string]: unknown;
  };
  models?: Record<string, OpenCodeModelEntry>;
  [key: string]: unknown;
}

export interface OpenCodeConfig {
  $schema?: string;
  provider?: Record<string, OpenCodeProvider>;
  [key: string]: unknown;
}
