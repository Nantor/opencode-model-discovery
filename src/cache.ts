import { createHash } from "node:crypto";

import type { Context } from "@opencode/plugin/promise/plugin";
import { discoveryHeaders, sanitizeModelInfoFields } from "./fetch.js";
import type { LiteLLMModel, LiteLLMModelInfoEntry } from "./types.js";

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
  const result = sanitizeModelInfoFields(entry);
  if (result.model_info.supported_openai_params) {
    // Only these two parameters affect compatibility; don't retain arbitrary strings.
    result.model_info.supported_openai_params = result.model_info.supported_openai_params.filter(
      (param) => param === "max_tokens" || param === "max_completion_tokens",
    );
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
    async scan({ prefix, after, limit }) {
      // Match OpenCode 2.2.3 KV.scan's default and numeric normalization.
      const size = Number.isNaN(limit) ? 100 : Math.min(Math.max(Math.floor(limit ?? 100), 1), 1000);
      // SQLite orders UTF-8 keys bytewise, unlike JS's UTF-16 string sort.
      // Use that order for both sorting and the exclusive (possibly absent) cursor.
      const cursor = after === undefined ? undefined : Buffer.from(after);
      const keys = [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, bytes: Buffer.from(key) }))
        .filter(({ bytes }) => cursor === undefined || Buffer.compare(bytes, cursor) > 0)
        .sort((a, b) => Buffer.compare(a.bytes, b.bytes));
      const page = keys.slice(0, size);
      const entries = page.map(({ key }) => ({ key, value: store.get(key) as never }));
      return keys.length > page.length ? { entries, next: page[page.length - 1].key } : { entries };
    },
  };
}
