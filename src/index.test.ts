import { describe, expect, it } from "vitest";

import pluginModule, { ModelDiscoveryPlugin } from "./index.js";

describe("plugin module", () => {
  it("exports the OpenCode server plugin module shape", () => {
    expect(pluginModule.id).toBe("opencode-model-discovery");
    expect(pluginModule.server).toBe(ModelDiscoveryPlugin);
  });
});
