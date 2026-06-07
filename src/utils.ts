import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import type {
  OpenCodeConfig,
  OpenCodeModelCost,
  OpenCodeModelLimit,
  OpenCodeProvider,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a display name from a raw model id, e.g. "gpt-4o-mini" → "Gpt 4o Mini"
 */
export function toDisplayName(
  id: string,
  cost?: OpenCodeModelCost,
  limit?: OpenCodeModelLimit,
): string {
  // strip trailing slashes before processing (e.g. "openai/" → "openai")
  const trimmed = id.replace(/\/+$/, "");
  // strip potential provider prefix like "openai/" or "anthropic/"
  const segment = trimmed.includes("/") ? trimmed.split("/").pop()! : trimmed;
  // fall back to the trimmed id when the trailing segment is empty
  const base = segment || trimmed || id;
  const name = base
    .replace(/-/g, " ")
    .replace(/[*_+~#§%&?=]+$/, "")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  let displayName = name + " ";
  if (cost) {
    const costParts = [];
    if (cost.input)
      costParts.push(`${cost.input.toFixed(2).replace(/\.?0+$/, "")}↑`);
    if (cost.output)
      costParts.push(`${cost.output.toFixed(2).replace(/\.?0+$/, "")}↓`);
    if (costParts.length > 0) {
      displayName += `(💰 ${costParts.join(" ")})`;
    }
  }
  if (limit) {
    const limitParts = [];
    if (limit.input) limitParts.push(`${toShortNum(limit.input)}↑`);
    if (limit.context) limitParts.push(`${toShortNum(limit.context)}↻`);
    if (limit.output) limitParts.push(`${toShortNum(limit.output)}↓`);
    if (limitParts.length > 0) {
      displayName += `[🪙 ${limitParts.join(" ")}]`;
    }
  }
  return displayName.trim();
}

function toShortNum(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return v.toString();
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
      [providerKey]: {...(((existing.provider ?? {})[providerKey]) ?? {}), ...providerValue},
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
    return join(dir, "opencode.jsonc");
  }
  if (opts.path) {
    const dir = resolve(opts.path);
    return join(dir, "opencode.json");
  }
  // Default: current working directory
  return resolve(process.cwd(), "opencode.json");
}
