import { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { fetchModelInfo, testModel } from "./fetch.js";
import { buildProviderConfig } from "./provider.js";
import { loadConfig, mergeProvider, resolveOutputPath } from "./utils.js";
import { validateConfig } from "./schema.js";

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
