import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import type { ModelsDevData, OpenCodeDiscoveryOptions } from "../src/types.js";
import { discoveryTimeout, normalizeBaseURL } from "../src/fetch.ts";
import { findModelsDevEntry, getModelsDevData } from "../src/models-dev.ts";

interface ProviderSettings {
  baseURL?: string;
  apiKey?: string;
  "opencode-model-discovery"?: OpenCodeDiscoveryOptions;
}

interface ProviderConfig {
  settings?: ProviderSettings;
  models?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

interface DebugConfig {
  $schema?: string;
  providers?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

const execFileAsync = promisify(execFile);
const resultsDirectory = resolve("debug");

function mergeRecords(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    // Avoid prototype setters when merging provider and model IDs.
    Object.defineProperty(result, key, {
      value: isRecord(result[key]) && isRecord(value)
        ? mergeRecords(result[key], value)
        : value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function parseConfigEntries(output: string): { config: DebugConfig; paths: string[] } {
  let entries: unknown;
  try {
    entries = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse opencode api get /api/config output: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(entries)) {
    throw new Error("Expected configuration entries from opencode api get /api/config");
  }
  let config: DebugConfig = {};
  const paths: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "document") continue;
    if (!isRecord(entry.info)) throw new Error("Invalid OpenCode configuration document");
    config = mergeRecords(config, entry.info) as DebugConfig;
    if (typeof entry.path === "string") paths.push(entry.path);
  }
  return { config, paths };
}

export function selectedProviderConfig(config: DebugConfig, providerID: string): DebugConfig {
  const provider = config.providers?.[providerID];
  if (!provider) {
    throw new Error(`Provider "${providerID}" was not found in OpenCode V2 configuration`);
  }
  return {
    ...(config.$schema === undefined ? {} : { $schema: config.$schema }),
    providers: { [providerID]: provider },
  };
}

/** V2 exposes resolved provider settings and model inventory as separate resources. */
export function runtimeProviderConfig(
  providerOutput: string,
  modelsOutput: string,
  providerID: string,
): DebugConfig {
  const providerResponse: unknown = JSON.parse(providerOutput);
  const modelsResponse: unknown = JSON.parse(modelsOutput);
  if (!isRecord(providerResponse) || !isRecord(providerResponse.data) ||
      providerResponse.data.id !== providerID) {
    throw new Error(`Invalid runtime provider response for "${providerID}"`);
  }
  if (!isRecord(modelsResponse) || !Array.isArray(modelsResponse.data)) {
    throw new Error("Invalid runtime model list response");
  }
  const models: Record<string, Record<string, unknown>> = Object.fromEntries(
    modelsResponse.data.flatMap((model: unknown) =>
      isRecord(model) && model.providerID === providerID && typeof model.id === "string"
        ? [[model.id, model]]
        : [],
    ),
  );
  return { providers: { [providerID]: { ...providerResponse.data, models } } };
}

async function apiGet(path: string): Promise<string> {
  const { stdout } = await execFileAsync("opencode", ["api", "get", path], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

function usage(): never {
  console.error("Usage: npm run debug:provider -- <provider-id>");
  process.exit(1);
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelIDs(response: unknown, field: "id" | "model_name"): Set<string> {
  if (!isRecord(response) || !Array.isArray(response.data)) return new Set();
  return new Set(
    response.data.flatMap((entry) =>
      isRecord(entry) && typeof entry[field] === "string" ? [entry[field]] : []
    ),
  );
}

function csvValue(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

export function modelSummaryCSV(
  models: unknown,
  modelInfo: unknown,
  config: DebugConfig,
  providerID: string,
  runtimeConfig?: DebugConfig,
  modelsDevData?: ModelsDevData,
): string {
  const fromModels = modelIDs(models, "id");
  const fromModelInfo = modelIDs(modelInfo, "model_name");
  const discoveryOptions = config.providers?.[providerID]?.settings?.["opencode-model-discovery"];
  const configModelEntries = config.providers?.[providerID]?.models ?? {};
  const configModels = new Set(Object.keys(configModelEntries));
  const runtimeModels = new Set(Object.keys(runtimeConfig?.providers?.[providerID]?.models ?? {}));
  const allModelIDs = new Set([...fromModels, ...fromModelInfo, ...configModels, ...runtimeModels]);
  const rows = [...allModelIDs]
    .sort((left, right) => left.localeCompare(right))
    .map((modelID) => [
      csvValue(modelID),
      String(fromModels.has(modelID)),
      String(fromModelInfo.has(modelID)),
      String(configModels.has(modelID)),
      String(
        Object.keys(configModelEntries[modelID] ?? {}).length === 1 &&
          typeof configModelEntries[modelID]?.name === "string",
      ),
      ...(runtimeConfig ? [String(runtimeModels.has(modelID))] : []),
      ...(modelsDevData
        ? [String(findModelsDevEntry(modelsDevData, modelID, discoveryOptions) !== undefined)]
        : []),
    ].join(","));
  const header = "model,models,model_info,config,config_name_only" +
    (runtimeConfig ? ",runtime" : "") +
    (modelsDevData ? ",models_dev" : "");
  return [header, ...rows].join("\n") + "\n";
}

export function providerSettings(providerID: string, config: DebugConfig): ProviderSettings {
  const provider = selectedProviderConfig(config, providerID).providers![providerID];
  if (typeof provider.settings?.baseURL !== "string" || !provider.settings.baseURL) {
    throw new Error(`Provider "${providerID}" has no settings.baseURL`);
  }
  return provider.settings;
}

async function fetchRaw(
  baseURL: string,
  path: string,
  apiKey: string | undefined,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const url = `${normalizeBaseURL(baseURL)}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Preserve raw data and represent optional endpoint failures explicitly, not as an empty inventory. */
export async function fetchDiscoveryResponses(
  baseURL: string,
  apiKey?: string,
  timeout?: unknown,
): Promise<{ models: unknown; modelInfo: unknown; modelInfoError?: string }> {
  const timeoutMs = discoveryTimeout(timeout);
  const [models, modelInfo] = await Promise.allSettled([
    fetchRaw(baseURL, "/v1/models?return_wildcard_routes=true", apiKey, timeoutMs),
    fetchRaw(baseURL, "/v2/model/info?return_wildcard_routes=true", apiKey, timeoutMs),
  ]);
  if (models.status === "rejected") throw models.reason;
  if (modelInfo.status === "fulfilled") return { models: models.value, modelInfo: modelInfo.value };
  const error = modelInfo.reason instanceof Error ? modelInfo.reason.message : String(modelInfo.reason);
  return { models: models.value, modelInfo: { error }, modelInfoError: error };
}

async function main(): Promise<void> {
  const providerID = process.argv[2] ?? usage();
  if (process.argv.length !== 3) usage();

  const stdout = await apiGet("/api/config");
  const { config, paths } = parseConfigEntries(stdout);
  const options = providerSettings(providerID, config);
  const discoveryOptions = options["opencode-model-discovery"];
  const baseURL = typeof discoveryOptions?.discoveryBaseURL === "string"
    ? discoveryOptions.discoveryBaseURL
    : options.baseURL!;

  console.log(`Provider: ${providerID}`);
  console.log(`Config: ${paths.join(", ")}`);
  console.log(`Discovery base URL: ${normalizeBaseURL(baseURL)}`);

  await mkdir(resultsDirectory, { recursive: true });
  const prefix = join(resultsDirectory, providerID.replaceAll(/[^a-zA-Z0-9._-]/g, "_"));

  const { models, modelInfo, modelInfoError } = await fetchDiscoveryResponses(
    baseURL, options.apiKey, discoveryOptions?.discoveryTimeout,
  );
  if (modelInfoError) console.warn(`Detailed model info unavailable: ${modelInfoError}`);
  const modelsPath = `${prefix}.models.json`;
  const modelInfoPath = `${prefix}.model-info.json`;
  await Promise.all([
    writeJSON(modelsPath, models),
    writeJSON(modelInfoPath, modelInfo),
  ]);

  const resolvedConfig = selectedProviderConfig(config, providerID);
  const configOutputPath = `${prefix}.opencode-config.json`;
  const runtimeOutputPath = `${prefix}.opencode-runtime.json`;
  const summaryPath = `${prefix}.models.csv`;
  await writeJSON(configOutputPath, resolvedConfig);
  let runtimeConfig: DebugConfig | undefined;
  try {
    const [providerOutput, modelsOutput] = await Promise.all([
      apiGet(`/api/provider/${encodeURIComponent(providerID)}`),
      apiGet("/api/model"),
    ]);
    runtimeConfig = runtimeProviderConfig(providerOutput, modelsOutput, providerID);
    await writeJSON(runtimeOutputPath, runtimeConfig);
  } catch (error) {
    console.warn(`Runtime inventory unavailable: ${error instanceof Error ? error.message : String(error)}`);
    await writeJSON(runtimeOutputPath, { error: "Runtime inventory unavailable" });
  }
  const modelsDevData = await getModelsDevData((level, message) => console[level](message));
  await writeFile(
    summaryPath,
    modelSummaryCSV(models, modelInfo, resolvedConfig, providerID, runtimeConfig, modelsDevData),
  );

  console.log("Wrote discovery results:");
  console.log(`  ${modelsPath}`);
  console.log(`  ${modelInfoPath}`);
  console.log(`  ${configOutputPath}`);
  console.log(`  ${runtimeOutputPath}`);
  console.log(`  ${summaryPath}`);
  if (modelInfoError) console.log("CSV model_info=false indicates unavailable detailed info, not confirmed absence.");
  console.log("Runtime models are a current snapshot; initial plugin discovery may still be pending. Rerun after discovery completes if models are missing.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
