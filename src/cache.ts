import { createHash } from "node:crypto";

import type { Context } from "@opencode/plugin/promise/plugin";

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
      void storage.remove(key).catch(() => undefined);
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
): string {
  const apiKeyHash = apiKey
    ? createHash("sha256").update(apiKey).digest("hex")
    : "none";
  return `discovery:${endpoint}:${baseURL}:${apiKeyHash}`;
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
