#!/usr/bin/env node
/**
 * litellm-to-opencode
 *
 * Fetches models from a LiteLLM-compatible API (GET /v1/models) and maps
 * them into an OpenCode provider config, writing or merging into opencode.json.
 *
 * Usage:
 *   npx tsx src/index.ts --base-url http://localhost:4000 [--api-key sk-...] [--global | --path /some/dir]
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiteLLMModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

interface LiteLLMModelInfo {
  id?: string;
  db_model?: boolean;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token?: unknown | number;
  output_cost_per_token?: number;
  key?: string;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token_flex?: unknown | number;
  input_cost_per_token_priority?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_272k_tokens?: number;
  cache_read_input_token_cost_flex?: unknown;
  cache_read_input_token_cost_priority?: number;
  input_cost_per_character?: unknown;
  input_cost_per_token_above_128k_tokens?: unknown | number;
  input_cost_per_token_above_200k_tokens?: number;
  input_cost_per_token_above_272k_tokens?: number;
  input_cost_per_query?: unknown;
  input_cost_per_second?: unknown;
  input_cost_per_audio_token?: number;
  input_cost_per_image_token?: unknown;
  input_cost_per_image?: unknown;
  input_cost_per_audio_per_second?: unknown;
  input_cost_per_video_per_second?: unknown;
  input_cost_per_token_batches?: number;
  output_cost_per_token_batches?: number;
  output_cost_per_token_flex?: unknown;
  output_cost_per_token_priority?: number;
  output_cost_per_audio_token?: unknown;
  output_cost_per_character?: unknown;
  output_cost_per_reasoning_token?: number;
  output_cost_per_token_above_128k_tokens?: unknown;
  output_cost_per_character_above_128k_tokens?: unknown;
  output_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_272k_tokens?: number;
  output_cost_per_second?: unknown;
  output_cost_per_second_1080p?: unknown;
  output_cost_per_video_per_second?: unknown;
  output_cost_per_image?: number;
  output_cost_per_image_token?: unknown;
  output_vector_size?: number;
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
}

interface LiteLLMParams {
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

interface LiteLLMModelInfoEntry {
  model_name: string;
  litellm_params: LiteLLMParams;
  model_info: LiteLLMModelInfo;
}

interface LiteLLMModelInfoResponse {
  data: LiteLLMModelInfoEntry[];
}

interface LiteLLMModelsResponse {
  object: string;
  data: LiteLLMModel[];
}

interface OpenCodeModelCost {
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

interface OpenCodeModelLimit {
  context: number;
  output: number;
  input?: number;
}

interface OpenCodeModelModalities {
  input: Array<"text" | "audio" | "image" | "video" | "pdf">;
  output: Array<"text" | "audio" | "image" | "video" | "pdf">;
}

interface OpenCodeModelEntry {
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

interface OpenCodeProvider {
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

// ---------------------------------------------------------------------------
// OpenCode config Zod schema — fetched at runtime from https://opencode.ai/config.json
// ---------------------------------------------------------------------------

const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

/**
 * Recursively remove any "$ref" keys whose value starts with "http" (external refs).
 * z.fromJSONSchema() only supports local refs (#/...).
 */
function stripExternalRefs(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripExternalRefs);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("http")) {
        // drop external $ref
        continue;
      }
      result[k] = stripExternalRefs(v);
    }
    return result;
  }
  return obj;
}

/** Module-level cache so we only fetch the schema once per process. */
let _schemaCache: ReturnType<typeof z.fromJSONSchema> | null = null;

/** Reset the schema cache — exposed for use in tests. */
export function resetSchemaCache(): void {
  _schemaCache = null;
}

/**
 * Fetch and compile the OpenCode JSON Schema from the canonical URL.
 * Result is cached after the first call.
 */
async function loadOpenCodeSchema(): Promise<
  ReturnType<typeof z.fromJSONSchema>
> {
  if (_schemaCache) return _schemaCache;
  const response = await fetch(OPENCODE_SCHEMA_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenCode schema from ${OPENCODE_SCHEMA_URL}: ${response.status} ${response.statusText}`,
    );
  }
  const raw = await response.json();
  const cleaned = stripExternalRefs(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _schemaCache = z.fromJSONSchema(cleaned as any);
  return _schemaCache;
}

/**
 * Validate a config object against the OpenCode schema fetched from the canonical URL.
 * Throws an error listing all validation failures if the config is invalid.
 */
export async function validateConfig(config: unknown): Promise<void> {
  const schema = await loadOpenCodeSchema();
  const result = schema.safeParse(config);
  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join(".") || "(root)"}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Generated config does not match the OpenCode schema:\n${errors}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Exported schema accessor (for tests)
// ---------------------------------------------------------------------------

/**
 * Returns the compiled Zod schema for the OpenCode config.
 * Fetches and caches on first call.
 */
export async function getOpenCodeConfigSchema(): Promise<
  ReturnType<typeof z.fromJSONSchema>
> {
  return loadOpenCodeSchema();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a display name from a raw model id, e.g. "gpt-4o-mini" → "Gpt 4o Mini"
 */
export function toDisplayName(id: string): string {
  // strip potential provider prefix like "openai/" or "anthropic/"
  const segment = id.includes("/") ? id.split("/").pop()! : id;
  // fall back to the full id when the trailing segment is empty (e.g. "openai/")
  const base = segment || id;
  return base.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Sanitize an arbitrary model id to a valid JSON key.
 * Keeps alphanumerics, hyphens, dots, underscores and forward slashes.
 */
export function sanitizeKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-._/]/g, "_");
}

/**
 * Load and parse an existing opencode.json; return empty config on missing file.
 */
export function loadConfig(filePath: string): OpenCodeConfig {
  if (!existsSync(filePath)) {
    return {
      $schema: "https://opencode.ai/config.json",
    };
  }
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as OpenCodeConfig;
  } catch {
    console.error(
      `Warning: could not parse existing config at ${filePath} – starting fresh.`,
    );
    return { $schema: "https://opencode.ai/config.json" };
  }
}

/**
 * Merge the new provider block into an existing config, replacing only the
 * named provider while leaving all other top-level keys untouched.
 */
export function mergeProvider(
  existing: OpenCodeConfig,
  providerKey: string,
  providerValue: OpenCodeProvider,
): OpenCodeConfig {
  return {
    ...existing,
    provider: {
      ...(existing.provider ?? {}),
      [providerKey]: providerValue,
    },
  };
}

/**
 * Resolve the output file path based on CLI flags.
 */
export function resolveOutputPath(opts: {
  global: boolean;
  path?: string;
}): string {
  if (opts.global) {
    const dir = join(homedir(), ".config", "opencode");
    return join(dir, "opencode.json");
  }
  if (opts.path) {
    const dir = resolve(opts.path);
    return join(dir, "opencode.json");
  }
  // Default: current working directory
  return resolve(process.cwd(), "opencode.json");
}

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
      } else if (contextTokens !== undefined) {
        // output is required by schema; skip limit when we can't satisfy it
      } else if (outputTokens !== undefined) {
        // context is required by schema; skip limit when we can't satisfy it
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

      // --- interleaved reasoning tokens ---
      // When merge_reasoning_content_in_choices is true, the provider streams
      // reasoning tokens interleaved in the choices[].message.reasoning_content field.
      if (params?.merge_reasoning_content_in_choices === true) {
        entry.interleaved = { field: "reasoning_content" };
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Only run CLI when this file is the entry point (not when imported by tests)
const _isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (_isMain) {
  runCLI();
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("litellm-to-opencode")
    .description(
      "Fetch models from a LiteLLM-compatible API and write them into an OpenCode provider config.",
    )
    .requiredOption(
      "--base-url <url>",
      "Base URL of the LiteLLM API, e.g. http://localhost:4000",
    )
    .option(
      "--api-key <key>",
      "API key / Bearer token for the LiteLLM endpoint",
    )
    .option(
      "--provider-id <id>",
      "Provider key used in opencode.json (default: litellm)",
      "litellm",
    )
    .option(
      "--provider-name <name>",
      "Human-readable provider display name (default: LiteLLM)",
      "LiteLLM",
    )
    .option(
      "--global",
      "Write to the global OpenCode config (~/.config/opencode/opencode.json)",
      false,
    )
    .option("--path <dir>", "Write to opencode.json inside the given directory")
    .option(
      "--dry-run",
      "Print the resulting config to stdout without writing any file",
      false,
    )
    .option(
      "--model-info",
      "Also fetch model details from /v1/model/info to populate max_tokens, cost data, feature flags, etc.",
      false,
    )
    .action(
      async (opts: {
        baseUrl: string;
        apiKey?: string;
        providerId: string;
        providerName: string;
        global: boolean;
        path?: string;
        dryRun: boolean;
        modelInfo: boolean;
      }) => {
        try {
          // 0. Validate mutually exclusive flags before any network work
          if (opts.global && opts.path) {
            console.error("Error: --global and --path are mutually exclusive.");
            process.exit(1);
          }

          // 1. Fetch
          const models = await fetchModels(opts.baseUrl, opts.apiKey);
          console.log(`Found ${models.length} model(s).`);

          let modelInfoEntries: LiteLLMModelInfoEntry[] = [];
          if (opts.modelInfo) {
            modelInfoEntries = await fetchModelInfo(opts.baseUrl, opts.apiKey);
            if (modelInfoEntries.length > 0) {
              console.log(`Fetched model info for ${modelInfoEntries.length} model(s).`);
            } else {
              console.log("No model info available; proceeding without model details.");
            }
          }

          // 2. Build provider block
          const providerConfig = buildProviderConfig(
            models,
            opts.baseUrl,
            opts.apiKey,
            opts.providerName,
            modelInfoEntries,
          );

          // 3. Resolve output path
          const outputPath = resolveOutputPath({
            global: opts.global,
            path: opts.path,
          });

          // 4. Load existing config and merge
          const existing = loadConfig(outputPath);
          const merged = mergeProvider(
            existing,
            opts.providerId,
            providerConfig,
          );

          // 5. Validate the merged config against the OpenCode schema
          await validateConfig(merged);

          const output = JSON.stringify(merged, null, 2) + "\n";

          if (opts.dryRun) {
            console.log("\n--- Dry run: resulting opencode.json ---\n");
            console.log(output);
            return;
          }

          // 6. Write
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, output, "utf-8");
          console.log(`\nConfig written to: ${outputPath}`);
          console.log(
            `Provider "${opts.providerId}" now has ${models.length} model(s) registered.`,
          );
        } catch (err) {
          console.error("Error:", err instanceof Error ? err.message : err);
          process.exit(1);
        }
      },
    );

  return program;
}

function runCLI(): void {
  createProgram().parse(process.argv);
}

