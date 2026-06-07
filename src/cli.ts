import { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { fetchModelInfo } from "./fetch.js";
import { buildProviderConfig } from "./provider.js";
import { loadConfig, mergeProvider, resolveOutputPath, loadDcpConfig, parsePercentage, resolveDcpConfigFile } from "./utils.js";
import { validateConfig } from "./schema.js";
import type { OpenCodeProvider } from "./types.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function createProgram(): Command {
  const program = new Command();

  program
    .name("litellm-to-opencode")
    .description(
      "Fetch models from a LiteLLM-compatible API and write them into an OpenCode provider config.",
    )
    .requiredOption(
      "-b, --base-url <url>",
      "Base URL of the LiteLLM API, e.g. http://localhost:4000",
    )
    .option(
      "-k, --api-key <key>",
      "API key / Bearer token for the LiteLLM endpoint",
    )
    .option(
      "-p, --provider-id <id>",
      "Provider key used in opencode.json (default: litellm)",
      "litellm",
    )
    .option(
      "-n, --provider-name <name>",
      "Human-readable provider display name (default: LiteLLM)",
      "LiteLLM",
    )
    .option(
      "-g, --global",
      "Write to the global OpenCode config (~/.config/opencode/opencode.json)",
      false,
    )
    .option("-P, --path <dir>", "Write to opencode.json inside the given directory")
    .option(
      "-D, --dry-run",
      "Print the resulting config to stdout without writing any file",
      false,
    )
    .option(
      "-d, --detailed-model-info <path>",
      "Path to file with detailed model information",
    )
    .option(
      "-r, --reasoning-summary-workaround",
      "Enable the reasoningSummary workaround for reasoning models",
      false,
    )
    .option(
      "--dcp-min <percent>",
      "Minimum context limit percentage for DCP (e.g. 80%)",
    )
    .option(
      "--dcp-max <percent>",
      "Maximum context limit percentage for DCP (e.g. 80%)",
    )
    .action(
      async (opts: {
        baseUrl: string;
        apiKey?: string;
        providerId: string;
        providerName: string;
        global: boolean;
        path?: string;
        dryRun: boolean;
        detailedModelInfo?: string;
        reasoningSummaryWorkaround: boolean;
        dcpMin?: string;
        dcpMax?: string;
      }) => {
        try {
          // 0. Validate mutually exclusive flags before any network work
          if (opts.global && opts.path) {
            console.error("Error: --global and --path are mutually exclusive.");
            process.exit(1);
          }

          // 1. Fetch
          const modelInfoEntries = await fetchModelInfo(opts.baseUrl, opts.apiKey);
          console.log(`Found ${modelInfoEntries.length} model(s).`);

          // 2.a Build provider block
          const providerConfig = buildProviderConfig(
            modelInfoEntries,
            opts.baseUrl,
            opts.apiKey,
            opts.providerName,
            opts.reasoningSummaryWorkaround,
          );

          // 2.b test all models
          // for (const [key, model] of Object.entries(providerConfig?.models || {})) {
          //       const testResult = await testModel(opts.baseUrl, model.id ?? key, opts.apiKey);
          //       console.log(model.name + ": " + (testResult.ok ? "OK" : `FAIL (${testResult.error})`));
          // }

          // 3. Resolve output path
          const outputPath = resolveOutputPath({
            global: opts.global,
            path: opts.path,
          });

          // 4. Load existing config and merge
          const existing = loadConfig(outputPath);
          const merged = mergeProvider(
            existing,
            opts.providerId,
            providerConfig,
          );

          // 5. Validate the merged config against the OpenCode schema
          await validateConfig(merged);

          // 6. Handle DCP config if --dcp-min or --dcp-max is set
          if (opts.dcpMin || opts.dcpMax) {
            const dcpMinVal = opts.dcpMin ? parsePercentage(opts.dcpMin) : undefined;
            const dcpMaxVal = opts.dcpMax ? parsePercentage(opts.dcpMax) : undefined;

            if (dcpMinVal === undefined && dcpMaxVal === undefined) {
              console.error("Error: Invalid percentage value for --dcp-min or --dcp-max");
              process.exit(1);
            }

            const dcpDir = dirname(outputPath);
            const dcpConfigPath = resolveDcpConfigFile(dcpDir);

            const providerConfig = merged.provider?.[opts.providerId] as OpenCodeProvider;
            const dcpConfig = loadDcpConfig(dcpConfigPath);

            if (dcpMinVal !== undefined || dcpMaxVal !== undefined) {
              for (const [modelKey, modelEntry] of Object.entries(providerConfig?.models ?? {})) {
                const contextInput = modelEntry.limit?.context;
                if (contextInput === undefined) continue;

                const modelId = modelEntry.id ?? modelKey;
                const fullKey = `${opts.providerId}/${modelId}`;

                if (dcpMinVal !== undefined) {
                  dcpConfig.compress = dcpConfig.compress ?? {};
                  dcpConfig.compress.minContextLimit = dcpConfig.compress.minContextLimit ?? {};
                  dcpConfig.compress.minContextLimit[fullKey] = dcpMinVal * contextInput;
                }

                if (dcpMaxVal !== undefined) {
                  dcpConfig.compress = dcpConfig.compress ?? {};
                  dcpConfig.compress.maxContextLimit = dcpConfig.compress.maxContextLimit ?? {};
                  dcpConfig.compress.maxContextLimit[fullKey] = dcpMaxVal * contextInput;
                }
              }
            }

            if (!opts.dryRun) {
              mkdirSync(dcpDir, { recursive: true });
              writeFileSync(dcpConfigPath, JSON.stringify(dcpConfig, null, 2), "utf-8");
              console.log(`\nDCP config written to: ${dcpConfigPath}`);
            } else {
              console.log("\n--- Dry run: resulting dcp.json ---\n");
              console.log(JSON.stringify(dcpConfig, null, 2));
            }
          }

          const output = JSON.stringify(merged, null, 2);

          if (opts.dryRun) {
            console.log("\n--- Dry run: resulting opencode.json ---\n");
            console.log(output);
            return;
          }

          // 7. Write
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, output, "utf-8");
          console.log(`\nConfig written to: ${outputPath}`);
          console.log(
            `Provider "${opts.providerId}" now has ${modelInfoEntries.length} model(s) registered.`,
          );
        } catch (err) {
          console.error("Error:", err instanceof Error ? err.message : err);
          process.exit(1);
        }
      },
    );

  return program;
}

export function runCLI(): void {
  createProgram().parse(process.argv);
}
