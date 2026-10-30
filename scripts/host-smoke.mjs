import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const exec = promisify(execFile);
const binary = process.env.OPENCODE_SMOKE_BINARY || "opencode";
const { stdout: version } = await exec(binary, ["--version"]);
assert.equal(version.trim(), "opencode v2.2.3", "This regression targets the supported host 2.2.3");
const root = resolve(process.env.OPENCODE_SMOKE_TMP || "/tmp/opencode");
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, "model-discovery-host-"));
console.log(`Actual-host artifacts: ${directory}`);
const metadata = {
  max_input_tokens: 8192, max_output_tokens: 1024,
  supports_vision: false, supports_function_calling: false,
  supported_openai_params: ["max_tokens"],
  input_cost_per_token: 0.000002, output_cost_per_token: 0.000004,
};
const ids = ["fresh-model", "source-model", "source-policy", "policy-model", "configured-model", "equal-defaults"];
const entries = ids.map((model_name) => ({ model_name, litellm_params: {}, model_info: metadata }));
entries.push({ model_name: "partial-input", litellm_params: {}, model_info: { max_input_tokens: 4096, supports_vision: false } },
  { model_name: "partial-output", litellm_params: {}, model_info: { max_output_tokens: 512, supports_function_calling: false } });
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  const path = new URL(request.url, "http://localhost").pathname;
  response.setHeader("content-type", "application/json");
  if (path === "/v1/models") response.end(JSON.stringify({ data: [...ids, "partial-input", "partial-output", "name-only"].map((id) => ({ id })) }));
  else if (path === "/v2/model/info") response.end(JSON.stringify({ data: entries }));
  else { response.statusCode = 404; response.end("{}"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  for (const order of ["earlier", "later"]) {
    const cwd = join(directory, order);
    for (const path of [".opencode/plugins", "home", "config", "data", "cache", "state", "runtime"])
      await mkdir(join(cwd, path), { recursive: true });
    await build({ entryPoints: [fileURLToPath(new URL("./fixtures/host-smoke.mjs", import.meta.url))],
      outfile: join(cwd, ".opencode/plugins/smoke.js"), bundle: true, platform: "node", format: "esm", target: "node24" });
    const configured = { name: "Configured name", disabled: false, limit: { output: 777 },
      capabilities: { tools: true, input: [] }, cost: [] };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: Object.fromEntries([false, true].map((enrich) => [`smoke-${enrich}`, { models: { "configured-model": configured } }])),
    }));
    const result = join(cwd, "result.json");
    // Allowlist environment: no inherited credentials, server URL, config or DB.
    const env = {
      PATH: process.env.PATH, HOME: join(cwd, "home"),
      XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data"),
      XDG_CACHE_HOME: join(cwd, "cache"), XDG_STATE_HOME: join(cwd, "state"), XDG_RUNTIME_DIR: join(cwd, "runtime"),
      OPENCODE_DB: join(cwd, "smoke.db"), OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_PASSWORD: "isolated-smoke-password",
      SMOKE_ORDER: order, SMOKE_URL: `http://127.0.0.1:${server.address().port}`, SMOKE_RESULT: result,
    };
    // Keep one private host alive across reads: startup's final config can
    // invalidate discovery inputs and require another asynchronous fetch/replay.
    const host = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let hostLog = "";
    host.stdout.on("data", (chunk) => { hostLog += chunk; });
    host.stderr.on("data", (chunk) => { hostLog += chunk; });
    let output;
    try {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        assert.equal(host.exitCode, null, hostLog);
        const address = hostLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) {
          output = await exec(binary, ["api", "get", "/api/model", "--server", address], { cwd, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
          if (JSON.parse(output.stdout).data.filter((model) => model.id === "fresh-model").length === 2) break;
        }
        await setTimeout(50);
      }
      assert.ok(output && JSON.parse(output.stdout).data.filter((model) => model.id === "fresh-model").length === 2,
        `Discovery did not settle: ${hostLog}`);
    } finally {
      const exited = new Promise((resolve) => host.once("close", resolve));
      host.kill("SIGTERM");
      await exited;
      await writeFile(join(cwd, "host.log"), hostLog);
    }
    await writeFile(join(cwd, "stdout.txt"), output.stdout);
    await writeFile(join(cwd, "stderr.txt"), output.stderr);
    const data = JSON.parse(await readFile(result, "utf8"));
    assert.ok(data.storageParity.scans > 500, "Actual host/memory storage comparisons completed");
    console.log(`PASS OpenCode 2.2.3: ${data.storageParity.scans} storage pagination parity checks`);
    // The host installs its configuration transform after plugin setup returns.
    const finalModels = JSON.parse(output.stdout).data;
    for (const enrich of [false, true]) {
      const providerID = `smoke-${enrich}`;
      const models = data.candidates[providerID];
      assert.equal(data.before[`${providerID}/policy-model`].limit.context, 200000, "Real callback received defaults");
      for (const id of ["fresh-model", "source-model", "equal-defaults"]) {
        const model = models[id];
        assert.deepEqual(model.limit, { context: 8192, input: 8192, output: 1024 });
        assert.deepEqual(model.capabilities, { tools: false, input: ["text"], output: ["text"] });
        assert.deepEqual(model.cost, [{ input: 2, output: 4, cache: { read: 0, write: 0 } }]);
        assert.equal(model.compatibility.maxTokensField, "max_tokens");
        assert.equal(model.name, id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "));
      }
      assert.equal(models["source-model"].family, "source-family");
      assert.deepEqual(models["partial-input"].limit, { context: 4096, input: 4096, output: 32000 });
      assert.deepEqual(models["partial-input"].capabilities, { tools: true, input: ["text"], output: ["text"] });
      assert.deepEqual(models["partial-output"].limit, { context: 200000, output: 512 });
      assert.deepEqual(models["partial-output"].capabilities, { tools: false, input: ["text", "image"], output: ["text"] });
      assert.deepEqual(models["partial-output"].cost, []);
      assert.equal(models["name-only"].name, "Name Only");
      assert.deepEqual(models["name-only"].limit, { context: 200000, output: 32000 });
      for (const id of ["policy-model", "source-policy"]) {
        const model = models[id];
        assert.equal(model.enabled, false);
        assert.equal(model.name, "Policy name");
        assert.equal(model.limit.output, 123);
        assert.equal(model.limit.context, id === "source-policy" && !enrich ? 128000 : 8192);
        assert.deepEqual(model.capabilities.input, []);
        assert.equal(model.cost[0].input, 7);
        assert.ok(!data.api.some((model) => model.providerID === providerID && model.id === id));
        assert.ok(!finalModels.some((model) => model.providerID === providerID && model.id === id));
      }
      // Verify the post-setup API retains the metadata observed during setup.
      for (const id of ["fresh-model", "source-model", "equal-defaults", "partial-input", "partial-output", "name-only"]) {
        const final = finalModels.find((model) => model.providerID === providerID && model.id === id);
        assert.ok(final, `Missing final model ${providerID}/${id}`);
        for (const field of ["name", "limit", "capabilities", "cost", "compatibility"])
          assert.deepEqual(final[field], models[id][field]);
      }
      const model = finalModels.find((model) => model.providerID === providerID && model.id === "configured-model");
      assert.equal(model.name, configured.name);
      assert.equal(model.enabled, true);
      assert.equal(model.limit.output, 777);
      assert.equal(model.capabilities.tools, true);
      assert.deepEqual(model.capabilities.input, []);
      assert.deepEqual(model.cost, []);
    }
    console.log(`PASS OpenCode 2.2.3: ${order} provider registration, enrichment false/true`);
  }
  assert.ok(requests.filter((url) => url.startsWith("/v1/models?")).length >= 4);
  assert.ok(requests.filter((url) => url.startsWith("/v2/model/info?")).length >= 4);
  await writeFile(join(directory, "requests.json"), JSON.stringify(requests, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
