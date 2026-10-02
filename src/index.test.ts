import { describe, expect, it } from "vitest";

import pluginModule, { ModelDiscoveryPlugin } from "./index.js";

describe("plugin module", () => {
  it("exports the OpenCode V2 plugin shape", () => {
    expect(pluginModule.id).toBe("opencode-model-discovery");
    expect(pluginModule.setup).toBe(ModelDiscoveryPlugin);
  });
});
