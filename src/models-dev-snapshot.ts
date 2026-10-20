import type { Logger, ModelsDevData } from "./types.js";
import { errorMessage, isModelsDevData, safeLog } from "./utils.ts";

// ---------------------------------------------------------------------------
// Bundled models.dev snapshot fallback
// ---------------------------------------------------------------------------
//
// This module is the ONLY place that imports the `@opencode-ai/models/snapshot`
// catalog. It is statically imported by `models-dev.ts` but only referenced
// from the compile-time `BUILD_SNAPSHOT` branch, so esbuild tree-shakes this
// module (and the bundled snapshot) out of the slim build when
// `BUILD_SNAPSHOT=false`.

/**
 * Load the bundled `@opencode-ai/models/snapshot` canonical catalog. Returns
 * `undefined` (without throwing) if the snapshot cannot be loaded, so that
 * provider discovery can continue without enhancement.
 */
export async function loadModelsDevSnapshot(
  log?: Logger,
): Promise<ModelsDevData | undefined> {
  try {
    const { models } = await import("@opencode-ai/models/snapshot");
    if (!isModelsDevData(models)) throw new Error("Unexpected models.dev snapshot format");
    return models;
  } catch (error) {
    await safeLog(log, "warn", `Could not load models.dev snapshot: ${errorMessage(error)}`);
    return undefined;
  }
}
