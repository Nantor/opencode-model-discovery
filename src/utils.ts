import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import type {
  OpenCodeConfig,
  OpenCodeModelCost,
  OpenCodeModelLimit,
  OpenCodeProvider,
} from "./types.js";

export interface DcpConfig {
  $schema?: string;
  compress?: {
    minContextLimit?: Record<string, number>;
    maxContextLimit?: Record<string, number>;
  };
}

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
 * Strip JSONC comments and trailing commas while preserving string contents by
 * tracking string boundaries and escape sequences.
 */
function stripJsoncComments(input: string): string {
  let result = "";
  let i = 0;

  while (i < input.length) {
    if (input[i] === '"') {
      // consume a double-quoted string verbatim
      let str = '"';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') {
          str += input[i];
          i++;
          if (i < input.length) {
            str += input[i];
            i++;
          }
          continue;
        }
        str += input[i];
        i++;
      }
      if (i < input.length) {
        str += '"';
        i++;
      }
      result += str;
    } else if (input[i] === '/' && input[i + 1] === '/') {
      // skip single-line comment
      while (i < input.length && input[i] !== '\n') i++;
    } else if (input[i] === '/' && input[i + 1] === '*') {
      // skip multi-line comment
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2; // skip */
    } else {
      result += input[i];
      i++;
    }
  }

  // now strip trailing commas by removing , before ] or } (with optional whitespace between)
  let output = "";
  i = 0;
  while (i < result.length) {
    if (result[i] === ',') {
      // look ahead past whitespace for ] or }
      let j = i + 1;
      while (j < result.length && /\s/.test(result[j])) j++;
      if (result[j] === ']' || result[j] === '}') {
        // trailing comma — skip it
        i++;
        continue;
      }
    }
    output += result[i];
    i++;
  }

  return output;
}

/**
 * Sanitize an arbitrary model id to a valid JSON key.
 * Keeps alphanumerics, hyphens, dots, underscores and forward slashes.
 */
export function sanitizeKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-._/]/g, "_");
}

/**
 * Resolve the config file path, trying .jsonc first then .json.
 * Returns the path of the first existing file, or the .json path as default.
 */
export function resolveConfigFile(dir: string): string {
  const jsoncPath = join(dir, "opencode.jsonc");
  const jsonPath = join(dir, "opencode.json");

  if (existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}

/**
 * Load and parse an existing opencode config file; return empty config on missing file.
 * Handles both JSON and JSONC (comments, trailing commas) by stripping comments first.
 */
export function loadConfig(filePath: string): OpenCodeConfig {
  if (!existsSync(filePath)) {
    return {
      $schema: "https://opencode.ai/config.json",
    };
  }
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(stripJsoncComments(raw)) as OpenCodeConfig;
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
 * Resolve the output config file path, trying opencode.jsonc first then opencode.json.
 * Writes to the returned path; if neither exists, defaults to .json.
 */
export function resolveOutputPath(opts: {
  global: boolean;
  path?: string;
}): string {
  if (opts.global) {
    const dir = join(homedir(), ".config", "opencode");
    return resolveConfigFile(dir);
  }
  if (opts.path) {
    const dir = resolve(opts.path);
    return resolveConfigFile(dir);
  }
  // Default: current working directory
  return resolveConfigFile(resolve(process.cwd()));
}

/**
 * Load and parse an existing DCP config file; return empty config on missing file.
 * Handles both JSON and JSONC (comments, trailing commas) by stripping comments first.
 */
export function loadDcpConfig(filePath: string): DcpConfig {
  if (!existsSync(filePath)) {
    return {
      $schema: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    };
  }
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(stripJsoncComments(raw)) as DcpConfig;
  } catch {
    console.error(
      `Warning: could not parse existing DCP config at ${filePath} – starting fresh.`,
    );
    return { $schema: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json" };
  }
}

/**
 * Merge DCP limits into a DCP config, replacing only the specified provider/model keys.
 */
export function mergeDcpLimits(
  existing: DcpConfig,
  providerKey: string,
  modelKey: string,
  minContextLimit?: number,
  maxContextLimit?: number,
): DcpConfig {
  const fullKey = `${providerKey}/${modelKey}`;
  const compress = existing.compress ?? {};
  const minContextLimitMap = compress.minContextLimit ?? {};
  const maxContextLimitMap = compress.maxContextLimit ?? {};

  if (minContextLimit !== undefined) {
    minContextLimitMap[fullKey] = minContextLimit;
  }
  if (maxContextLimit !== undefined) {
    maxContextLimitMap[fullKey] = maxContextLimit;
  }

  return {
    ...existing,
    compress: {
      ...compress,
      minContextLimit: minContextLimitMap,
      maxContextLimit: maxContextLimitMap,
    },
  };
}

/**
 * Parse a percentage string (e.g. "80%" or "80") into a decimal value (0-1).
 * Returns undefined if the value is invalid or out of range.
 */
export function parsePercentage(value: string): number | undefined {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (!match) return undefined;
  const percent = parseFloat(match[1]);
  if (percent < 0 || percent > 100) return undefined;
  return percent / 100;
}

/**
 * Resolve the DCP config file path, trying dcp.jsonc first then dcp.json.
 * Returns the path of the first existing file, or the .json path as default.
 */
export function resolveDcpConfigFile(dir: string): string {
  const jsoncPath = join(dir, "dcp.jsonc");
  const jsonPath = join(dir, "dcp.json");

  if (existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}
