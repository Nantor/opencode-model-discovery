import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { OpenCodeConfig, OpenCodeProvider } from "../src/types.js";

const execFileAsync = promisify(execFile);
const configDirectory = join(homedir(), ".config", "opencode");
const configPaths = [
  join(configDirectory, "opencode.json"),
  join(configDirectory, "opencode.jsonc"),
];
const resultsDirectory = resolve("debug");

function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function parseJSONC(source: string, path: string): OpenCodeConfig {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }

  try {
    return JSON.parse(output.replace(/,\s*([}\]])/g, "$1")) as OpenCodeConfig;
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
  }
}

async function readConfig(path: string): Promise<OpenCodeConfig | undefined> {
  try {
    return parseJSONC(await readFile(path, "utf8"), path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadConfig(): Promise<{ config: OpenCodeConfig; paths: string[] }> {
  const configs = await Promise.all(configPaths.map(readConfig));
  const paths = configPaths.filter((_, index) => configs[index] !== undefined);
  if (paths.length === 0) {
    throw new Error(`No OpenCode config found in ${configDirectory}`);
  }

  return {
    config: {
      provider: Object.assign({}, ...configs.map((config) => config?.provider)),
    },
    paths,
  };
}

function selectedProviderConfig(output: string, providerID: string): OpenCodeConfig {
  let config: OpenCodeConfig;
  try {
    config = JSON.parse(output) as OpenCodeConfig;
  } catch (error) {
    throw new Error(
      `Could not parse opencode debug config output: ${error instanceof Error ? error.message : String(error)}`,
        {cause: error}
    );
  }

  const provider = config.provider?.[providerID];
  if (!provider) {
    throw new Error(`Provider "${providerID}" was not found in opencode debug config output`);
  }
  return {
    ...(config.$schema === undefined ? {} : { $schema: config.$schema }),
    provider: { [providerID]: provider },
  };
}

function usage(): never {
  console.error("Usage: npm run debug:provider -- <provider-id>");
  process.exit(1);
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function modelSummaryCSV(
  models: unknown,
  modelInfo: unknown,
  config: OpenCodeConfig,
  providerID: string,
): string {
  const fromModels = modelIDs(models, "id");
  const fromModelInfo = modelIDs(modelInfo, "model_name");
  const configModelEntries = config.provider?.[providerID]?.models ?? {};
  const configModels = new Set(Object.keys(configModelEntries));
  const allModelIDs = new Set([...fromModels, ...fromModelInfo, ...configModels]);
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
    ].join(","));
  return ["model,models,model_info,config,config_name_only", ...rows].join("\n") + "\n";
}

function providerOptions(providerID: string, config: OpenCodeConfig): OpenCodeProvider {
  const provider = config.provider?.[providerID];
  if (!provider) {
    throw new Error(`Provider "${providerID}" was not found in ${configPaths.join(" or ")}`);
  }
  if (!provider.options?.baseURL) {
    throw new Error(`Provider "${providerID}" has no options.baseURL`);
  }
  return provider;
}

async function fetchRaw(
  baseURL: string,
  path: string,
  apiKey: string | undefined,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${normalizeBaseURL(baseURL)}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${response.url}`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const providerID = process.argv[2] ?? usage();
  if (process.argv.length !== 3) usage();

  const { config, paths } = await loadConfig();
  const provider = providerOptions(providerID, config);
  const options = provider.options!;
  const discoveryOptions = options["opencode-model-discovery"];
  const baseURL = typeof discoveryOptions?.discoveryBaseURL === "string"
    ? discoveryOptions.discoveryBaseURL
    : options.baseURL!;
  const timeoutMs = typeof discoveryOptions?.discoveryTimeout === "number"
    ? discoveryOptions.discoveryTimeout
    : undefined;

  console.log(`Provider: ${providerID}`);
  console.log(`Config: ${paths.join(", ")}`);
  console.log(`Discovery base URL: ${normalizeBaseURL(baseURL)}`);

  await mkdir(resultsDirectory, { recursive: true });
  const prefix = join(resultsDirectory, providerID.replaceAll(/[^a-zA-Z0-9._-]/g, "_"));

  const [models, modelInfo] = await Promise.all([
    fetchRaw(baseURL, "/v1/models?return_wildcard_routes=true", options.apiKey, timeoutMs),
    fetchRaw(baseURL, "/v2/model/info?return_wildcard_routes=true", options.apiKey, timeoutMs),
  ]);
  const modelsPath = `${prefix}.models.json`;
  const modelInfoPath = `${prefix}.model-info.json`;
  await Promise.all([
    writeJSON(modelsPath, models),
    writeJSON(modelInfoPath, modelInfo),
  ]);

  const { stdout } = await execFileAsync("opencode", ["debug", "config"], {
    maxBuffer: 50 * 1024 * 1024,
  });
  const resolvedConfig = selectedProviderConfig(stdout, providerID);
  const configOutputPath = `${prefix}.opencode-config.json`;
  const summaryPath = `${prefix}.models.csv`;
  await Promise.all([
    writeJSON(configOutputPath, resolvedConfig),
    writeFile(summaryPath, modelSummaryCSV(models, modelInfo, resolvedConfig, providerID)),
  ]);

  console.log("Wrote discovery results:");
  console.log(`  ${modelsPath}`);
  console.log(`  ${modelInfoPath}`);
  console.log(`  ${configOutputPath}`);
  console.log(`  ${summaryPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
