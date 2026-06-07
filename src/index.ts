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

import { pathToFileURL } from "node:url";
import { runCLI } from "./cli.js";

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export type { OpenCodeConfig } from "./types.js";
export { toDisplayName, sanitizeKey, resolveConfigFile, loadConfig, mergeProvider, resolveOutputPath } from "./utils.js";
export { fetchModels, fetchModelInfo, testModel } from "./fetch.js";
export { buildProviderConfig } from "./provider.js";
export { validateConfig, getOpenCodeConfigSchema, resetSchemaCache } from "./schema.js";
export { createProgram } from "./cli.js";

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

// Only run CLI when this file is the entry point (not when imported by tests)
const _isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (_isMain) {
  runCLI();
}
