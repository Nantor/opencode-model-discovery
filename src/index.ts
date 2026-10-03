import { Plugin } from "@opencode/plugin";

import { ModelDiscoveryPlugin } from "./plugin.js";

export {
  ModelDiscoveryPlugin,
  applyDiscovery,
  discoverProviderModels,
} from "./plugin.js";
export { createMemoryStorage, type Storage } from "./cache.js";

export default Plugin.define({
  id: "opencode-model-discovery",
  setup: ModelDiscoveryPlugin,
});
