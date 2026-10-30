import type { Logger, ModelsDevData, ModelsDevModel } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Fill undefined fields recursively; explicit values (including arrays and null) win. */
export function fillMissingFields<T extends object>(configured: T, discovered: object): T {
  const result = { ...configured } as Record<string, unknown>;
  for (const [key, value] of Object.entries(discovered)) {
    const existing = Object.hasOwn(result, key) ? result[key] : undefined;
    if (existing === undefined || (isPlainObject(existing) && isPlainObject(value))) {
      Object.defineProperty(result, key, {
        value: isPlainObject(value)
          ? fillMissingFields(isPlainObject(existing) ? existing : {}, value)
          : Array.isArray(value) ? structuredClone(value) : value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result as T;
}

/**
 * Type guard for the flat models.dev catalog shape: an object whose values are
 * non-array model objects (each with a string `id` and no nested `models`
 * property). Returns false for provider-grouped or malformed catalogs.
 */
export function isModelsDevData(value: unknown): value is ModelsDevData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (model) => typeof model === "object" && model !== null && !Array.isArray(model) &&
      typeof (model as Partial<ModelsDevModel>).id === "string" && !("models" in model),
  );
}

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
