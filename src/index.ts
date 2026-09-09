import type { PluginModule } from "@opencode-ai/plugin";

import { ModelDiscoveryPlugin } from "./plugin.js";

export {
  ModelDiscoveryPlugin,
  applyDiscovery,
  discoverProviderModels,
} from "./plugin.js";

export default {
  id: "opencode-model-discovery",
  server: ModelDiscoveryPlugin,
} satisfies PluginModule;
