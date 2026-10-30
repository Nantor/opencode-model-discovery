import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const entry = fileURLToPath(new URL("./debug-provider.ts", import.meta.url));
const catalog = new URL("../src/models-dev.ts", import.meta.url).href;
const failures = {
  offline: 'throw new Error("offline")',
  "invalid JSON": 'return new Response("not json")',
  "invalid catalog": 'return Response.json({ invalid: true })',
};

describe("unbundled Node catalog fallback", () => {
  it.each(Object.entries(failures))("imports source and loads the snapshot with %s", async (_name, failure) => {
    // A fresh Node process receives neither Vitest transforms nor its define.
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { getModelsDevData, findModelsDevEntry } from ${JSON.stringify(catalog)};
      globalThis.fetch = async () => { ${failure}; };
      const data = await getModelsDevData();
      assert.ok(findModelsDevEntry(data, "gpt-4o"));
      console.log("snapshot loaded");
    `], { timeout: 15_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(stdout.trim()).toBe("snapshot loaded");
  });

  it.each(Object.entries(failures))("runs the debug entry and writes summaries with %s", async (_name, failure) => {
    const directory = await mkdtemp(join(tmpdir(), "model-discovery-node-"));
    try {
      const preload = join(directory, "mock-services.mjs");
      // Intercept every external operation: no OpenCode CLI/service or network
      // is used, but Node executes the actual TypeScript entry and main().
      await writeFile(preload, `
        import assert from "node:assert/strict";
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        import { promisify } from "node:util";
        const responses = {
          "/api/config": [{ type: "document", info: { providers: {
            gateway: { settings: { baseURL: "https://gateway.invalid/v1" } }
          } } }],
          "/api/provider/gateway": { data: { id: "gateway" } },
          "/api/model": { data: [{ id: "gpt-4o", providerID: "gateway" }] },
        };
        childProcess.execFile = (command, args, options, callback) => {
          assert.equal(command, "opencode");
          assert.deepEqual(args.slice(0, 2), ["api", "get"]);
          assert.ok(Object.hasOwn(responses, args[2]));
          callback(null, JSON.stringify(responses[args[2]]), "");
        };
        childProcess.execFile[promisify.custom] = (command, args, options) =>
          new Promise((resolve, reject) => childProcess.execFile(command, args, options,
            (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
        syncBuiltinESMExports();
        globalThis.fetch = async (input) => {
          const url = String(input);
          if (url === "https://models.dev/models.json") { ${failure}; }
          if (url === "https://gateway.invalid/v1/models?return_wildcard_routes=true") {
            return Response.json({ data: [{ id: "gpt-4o" }] });
          }
          if (url === "https://gateway.invalid/v2/model/info?return_wildcard_routes=true") {
            return Response.json({ data: [{ model_name: "gpt-4o" }] });
          }
          throw new Error("Unexpected request: " + url);
        };
      `);
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        "--import", pathToFileURL(preload).href, entry, "gateway",
      ], { cwd: directory, timeout: 15_000, env: { ...process.env, NODE_OPTIONS: "" } });
      expect(stderr).toContain("Could not fetch models.dev catalog");
      expect(stdout).toContain("Wrote discovery results:");
      const csv = await readFile(join(directory, "debug/gateway.models.csv"), "utf8");
      expect(csv).toBe(
        'model,models,model_info,config,config_name_only,runtime,models_dev\n"gpt-4o",true,true,false,false,true,true\n',
      );
      const summary = JSON.parse(await readFile(join(directory, "debug/gateway.models-dev.json"), "utf8"));
      expect(summary["gpt-4o"]).toMatchObject({ name: expect.any(String), limit: { context: expect.any(Number) } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
