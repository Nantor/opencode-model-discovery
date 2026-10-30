import { createHash } from "node:crypto";

import type { Context } from "@opencode/plugin/promise/plugin";
import { discoveryHeaders } from "./fetch.js";
import { toNum, type LiteLLMModel, type LiteLLMModelInfoEntry } from "./types.js";

export type Storage = Context["storage"];

type CacheEntry<T> = {
  createdAt: number;
  value: T;
};

const ISO_8601_DURATION = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function parseCacheDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_8601_DURATION.exec(value);
  if (!match) return undefined;

  const [, weeks = "0", days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const durationMs =
    Number(weeks) * 7 * 24 * 60 * 60 * 1_000 +
    Number(days) * 24 * 60 * 60 * 1_000 +
    Number(hours) * 60 * 60 * 1_000 +
    Number(minutes) * 60 * 1_000 +
    Number(seconds) * 1_000;
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined;
}

export function isArrayOf<T>(isItem: (value: unknown) => value is T): (value: unknown) => value is T[] {
  return (value): value is T[] => Array.isArray(value) && value.every(isItem);
}

/**
 * Read a cached value from OpenCode storage. Entries that are expired,
 * malformed, or whose `value` fails `isValid` are treated as a cache miss.
 */
export async function readCache<T>(
  storage: Storage,
  key: string,
  durationMs: number,
  isValid: (value: unknown) => value is T,
): Promise<T | undefined> {
  try {
    const entry = (await storage.get(key)) as CacheEntry<unknown> | undefined;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.createdAt !== "number" ||
      !Number.isFinite(entry.createdAt)
    ) {
      return undefined;
    }
    if (Date.now() - entry.createdAt > durationMs) {
      // Finish eviction before a cache miss lets the caller write a replacement.
      await storage.remove(key);
      return undefined;
    }
    if (!isValid(entry.value)) {
      return undefined;
    }
    return entry.value;
  } catch {
    return undefined;
  }
}

export async function writeCache<T>(
  storage: Storage,
  key: string,
  value: T,
): Promise<void> {
  const entry: CacheEntry<T> = { createdAt: Date.now(), value };
  try {
    await storage.set(key, entry as never);
  } catch {
    // Cache failures must never prevent model discovery
  }
}

export function discoveryCacheKey(
  endpoint: "models" | "model-info",
  baseURL: string,
  apiKey?: string,
  headers?: Readonly<Record<string, string>>,
): string {
  // Every header can select auth, tenant, or routing scope. Hash the effective
  // request headers in canonical name order; never persist configured secrets.
  const headerHash = createHash("sha256")
    .update(JSON.stringify([...discoveryHeaders(apiKey, headers).entries()]))
    .digest("hex");
  const endpointHash = createHash("sha256").update(baseURL).digest("hex");
  // Invalidate pre-projection caches, which may contain raw response credentials.
  // Never read/migrate their values into this namespace.
  return `discovery:v2:${endpoint}:${endpointHash}:${headerHash}`;
}

/** Persist only model-list fields used for route matching and mode filtering. */
export function cacheModel(model: LiteLLMModel): LiteLLMModel {
  return { id: model.id, ...(typeof model.mode === "string" ? { mode: model.mode } : {}) };
}

/** Allowlist discovery metadata; never copy arbitrary upstream response objects. */
export function cacheModelInfo(entry: LiteLLMModelInfoEntry): LiteLLMModelInfoEntry {
  const result: LiteLLMModelInfoEntry = { model_name: entry.model_name, litellm_params: {}, model_info: {} };
  const params = entry.litellm_params;
  if (typeof params.model === "string") result.litellm_params.model = params.model;
  if (typeof params.merge_reasoning_content_in_choices === "boolean") {
    result.litellm_params.merge_reasoning_content_in_choices = params.merge_reasoning_content_in_choices;
  }
  const info = entry.model_info;
  if (typeof info.mode === "string") result.model_info.mode = info.mode;
  if (Array.isArray(info.supported_openai_params)) {
    // Only these two parameters affect compatibility; don't retain arbitrary strings.
    result.model_info.supported_openai_params = info.supported_openai_params.filter(
      (param) => param === "max_tokens" || param === "max_completion_tokens",
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

export function createMemoryStorage(): Storage {
  const store = new Map<string, unknown>();
  return {
    async get(key: string) {
      return store.get(key) as never;
    },
    async set(key: string, value: unknown) {
      store.set(key, value);
    },
    async remove(key: string) {
      store.delete(key);
    },
    async scan(options: { prefix: string; after?: string; limit?: number }) {
      const entries: Array<{ key: string; value: never }> = [];
      for (const [key, value] of store.entries()) {
        if (key.startsWith(options.prefix)) {
          entries.push({ key, value: value as never });
        }
      }
      return { entries };
    },
  };
}
