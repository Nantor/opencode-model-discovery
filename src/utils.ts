import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import type { OpenCodeConfig, OpenCodeProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
