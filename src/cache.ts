import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

function cacheDirectory(): string {
  return process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "opencode-model-discovery")
    : join(homedir(), ".cache", "opencode-model-discovery");
}

function cachePath(key: string): string {
  return join(cacheDirectory(), `${createHash("sha256").update(key).digest("hex")}.json`);
}

export function isArrayOf<T>(isItem: (value: unknown) => value is T): (value: unknown) => value is T[] {
  return (value): value is T[] => Array.isArray(value) && value.every(isItem);
}

/**
 * Read a cached value. Entries that are expired, malformed, or whose `value`
 * fails `isValid` are treated as a cache miss so a corrupted cache file can
 * never break discovery until it expires.
 */
export async function readCache<T>(
  key: string,
  durationMs: number,
  isValid: (value: unknown) => value is T,
): Promise<T | undefined> {
  try {
    const entry = JSON.parse(await readFile(cachePath(key), "utf8")) as CacheEntry<unknown>;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.createdAt !== "number" ||
      !Number.isFinite(entry.createdAt) ||
      Date.now() - entry.createdAt > durationMs ||
      !isValid(entry.value)
    ) {
      return undefined;
    }
    return entry.value;
  } catch {
    return undefined;
  }
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  const directory = cacheDirectory();
  const path = cachePath(key);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const entry: CacheEntry<T> = { createdAt: Date.now(), value };

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(entry), "utf8");
    await rename(temporaryPath, path);
  } catch {
    // Cache failures must never prevent model discovery.
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
  return `${endpoint}:${baseURL}:${apiKeyHash}`;
}
