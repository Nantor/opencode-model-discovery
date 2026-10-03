import type { Logger } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an unknown thrown value into a human-readable message string.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Invoke a logger without letting it throw. Logging must never break discovery
 * or provider initialization.
 */
export async function safeLog(
  log: Logger | undefined,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await log?.(level, message);
  } catch {
    // Swallow logging failures on purpose.
  }
}

/**
 * Build a display name from a raw model id, e.g. "gpt-4o-mini" → "Gpt 4o Mini"
 */
export function toDisplayName(id: string): string {
  // strip trailing slashes before processing (e.g. "openai/" → "openai")
  const trimmed = id.replace(/\/+$/, "");
  // strip potential provider prefix like "openai/" or "anthropic/"
  const segment = trimmed.includes("/") ? trimmed.split("/").pop()! : trimmed;
  // fall back to the trimmed id when the trailing segment is empty
  const base = segment || trimmed || id;
  return base
    .replace(/-/g, " ")
    .replace(/[*_+~#§%&?=]+$/, "")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Sort an object's keys alphabetically by a given string key in the nested objects.
 */
export function sortByKey<T extends Record<string, object>>(
  obj: T,
  key: string,
): T {
  return Object.fromEntries(Object.entries(obj).sort(([, a], [, b]) => {
    const aVal = a && typeof a === "object" && key in a ? (a as Record<string, unknown>)[key] : "";
    const bVal = b && typeof b === "object" && key in b ? (b as Record<string, unknown>)[key] : "";
    const aStr = String(aVal);
    const bStr = String(bVal);
    return aStr.localeCompare(bStr, "en", { numeric: true });
  })) as T;
}
