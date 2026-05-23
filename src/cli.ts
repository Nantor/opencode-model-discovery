import { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { fetchModels, fetchModelInfo } from "./fetch.js";
import { buildProviderConfig } from "./provider.js";
import { loadConfig, mergeProvider, resolveOutputPath } from "./utils.js";
import { validateConfig } from "./schema.js";
import type { LiteLLMModelInfoEntry } from "./types.js";

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
      "--base-url <url>",
      "Base URL of the LiteLLM API, e.g. http://localhost:4000",
    )
    .option(
      "--api-key <key>",
      "API key / Bearer token for the LiteLLM endpoint",
    )
    .option(
      "--provider-id <id>",
      "Provider key used in opencode.json (default: litellm)",
      "litellm",
    )
    .option(
      "--provider-name <name>",
      "Human-readable provider display name (default: LiteLLM)",
      "LiteLLM",
    )
    .option(
      "--global",
      "Write to the global OpenCode config (~/.config/opencode/opencode.json)",
      false,
    )
    .option("--path <dir>", "Write to opencode.json inside the given directory")
    .option(
      "--dry-run",
      "Print the resulting config to stdout without writing any file",
      false,
    )
    .option(
      "--model-info",
      "Also fetch model details from /v1/model/info to populate max_tokens, cost data, feature flags, etc.",
      false,
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
        modelInfo: boolean;
      }) => {
        try {
          // 0. Validate mutually exclusive flags before any network work
          if (opts.global && opts.path) {
            console.error("Error: --global and --path are mutually exclusive.");
            process.exit(1);
          }

          // 1. Fetch
          const models = await fetchModels(opts.baseUrl, opts.apiKey);
          console.log(`Found ${models.length} model(s).`);

          let modelInfoEntries: LiteLLMModelInfoEntry[] = [];
          if (opts.modelInfo) {
            modelInfoEntries = await fetchModelInfo(opts.baseUrl, opts.apiKey);
            if (modelInfoEntries.length > 0) {
              console.log(`Fetched model info for ${modelInfoEntries.length} model(s).`);
            } else {
              console.log("No model info available; proceeding without model details.");
            }
          } else {
            console.warn(
              "Warning: --model-info not set. Models will be written without limit, cost, or feature-flag data. Re-run with --model-info to populate richer metadata.",
            );
          }

          // 2. Build provider block
          const providerConfig = buildProviderConfig(
            models,
            opts.baseUrl,
            opts.apiKey,
            opts.providerName,
            modelInfoEntries,
          );

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

          const output = JSON.stringify(merged, null, 2) + "\n";

          if (opts.dryRun) {
            console.log("\n--- Dry run: resulting opencode.json ---\n");
            console.log(output);
            return;
          }

          // 6. Write
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, output, "utf-8");
          console.log(`\nConfig written to: ${outputPath}`);
          console.log(
            `Provider "${opts.providerId}" now has ${models.length} model(s) registered.`,
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
