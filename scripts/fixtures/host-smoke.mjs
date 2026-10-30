import { Model, Provider } from "@opencode/plugin";
import { writeFile } from "node:fs/promises";
import { ModelDiscoveryPlugin } from "../../dist/opencode-model-discovery.js";

// Executed by the real host, never by a simulated editor.
export default {
  id: "model-discovery-host-smoke",
  async setup(ctx) {
    const baseURL = process.env.SMOKE_URL;
    const register = () => ctx.provider.transform((editor) => {
      for (const enrich of [false, true]) {
        const id = Provider.ID.make(`smoke-${enrich}`);
        const models = ["source-model", "source-policy"].map((name) => ({
          ...Model.Info.default(id, Model.ID.make(name)),
          name: "Source name", family: "source-family",
          limit: { context: 128000, output: 16384 },
        }));
        editor.add({ info: {
          ...Provider.Info.empty(id), activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${baseURL}/v1`, "opencode-model-discovery": {
            discovery: true, enrichExistingModels: enrich,
          } },
        }, models });
      }
    });
    if (process.env.SMOKE_ORDER === "earlier") await register();
    const before = {};
    await ctx.model.transform((editor) => {
      for (const id of ["smoke-false", "smoke-true"]) {
        if (!editor.provider.get(id)) continue;
        for (const modelID of ["policy-model", "source-policy", "configured-model"]) {
          editor.update(id, modelID, (model) => {
            before[`${id}/${modelID}`] = structuredClone(model);
            model.enabled = false;
            model.name = "Policy name";
            model.limit.output = 123;
            model.capabilities.input = [];
            model.cost = [{ input: 7, output: 9, cache: { read: 0, write: 0 } }];
          });
        }
        editor.update(id, "equal-defaults", (model) => {
          model.limit.output = 32000;
          model.capabilities.tools = true;
          model.cost = [];
        });
      }
    });
    const cleanup = await ModelDiscoveryPlugin(ctx);
    if (process.env.SMOKE_ORDER === "later") await register();
    let edited = [];
    await ctx.model.transform((editor) => { edited = structuredClone(editor.list()); });
    // Wait for asynchronous discovery and its replay; bounded by the runner too.
    let models;
    for (let attempt = 0; attempt < 200; attempt++) {
      models = await ctx.model.list();
      if (models.data.filter((m) => m.id === "fresh-model").length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const candidates = {};
    // Observe disabled policy candidates through a real editor; verify their
    // exclusion separately in the final API, which only lists enabled models.
    for (const id of ["smoke-false", "smoke-true"]) {
      candidates[id] = {};
      for (const modelID of ["fresh-model", "partial-input", "partial-output", "name-only",
        "source-model", "source-policy", "policy-model", "configured-model", "equal-defaults"]) {
        candidates[id][modelID] = (modelID.endsWith("policy") || modelID === "policy-model" ? edited : models.data)
          .find((model) => model.providerID === id && model.id === modelID);
      }
    }
    await writeFile(process.env.SMOKE_RESULT, JSON.stringify({ version: ctx.app.version, before, candidates, api: models.data }, null, 2));
    return cleanup;
  },
};
