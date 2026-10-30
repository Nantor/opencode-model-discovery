import type { Context } from "@opencode/plugin/promise/plugin";
import type { ProviderRecord } from "@opencode/plugin/promise/provider";
import type { OpenCodeProvider } from "./types.js";

const key = "opencode-model-discovery";
type Options = NonNullable<OpenCodeProvider["options"]>[typeof key];

/** Keep discovery inputs out of provider settings without assuming a config/plugin order. */
export async function providerSettings(
  ctx: Context,
  fingerprint: (value: unknown) => string,
): Promise<{
  options: (record: ProviderRecord) => Options;
  reconcile: (records: readonly ProviderRecord[]) => void;
  dispose: () => void;
}> {
  let disposed = false;
  let moving = false;
  let generation = 0;
  let captured = new Map<string, { settings: ProviderRecord["provider"]["settings"]; scope: string; options: Options }>();
  const scope = (record: ProviderRecord): string => fingerprint({ provider: record.provider, sourceConnection: record.sourceConnection });
  const register = (): ReturnType<Context["provider"]["transform"]> => {
    const current = ++generation;
    return ctx.provider.transform((editor) => {
      if (disposed || current !== generation) return;
      // A provider rebuild starts from sources, never the previous cleaned output.
      // Drop captures even when a provider disappeared or removed its opt-in.
      captured = new Map();
      for (const record of editor.list()) {
        if (!Object.hasOwn(record.provider.settings ?? {}, key)) continue;
        const options = structuredClone(record.provider.settings?.[key]) as Options;
        editor.update(record.provider.id, (info) => { delete info.settings?.[key]; });
        const cleaned = editor.get(record.provider.id);
        if (cleaned) captured.set(record.provider.id, { settings: cleaned.provider.settings, scope: scope(cleaned), options });
      }
    });
  };
  let registration = await register();
  const matches = (record: ProviderRecord): boolean => {
    const capture = captured.get(record.provider.id);
    // The host preserves settings references in its immutable provider snapshot.
    // Identity rejects a later replacement with an otherwise identical provider;
    // the digest also rejects in-place edits to endpoint/auth/connection/options.
    return capture !== undefined && capture.settings === record.provider.settings && capture.scope === scope(record);
  };
  return {
    options: (record) => Object.hasOwn(record.provider.settings ?? {}, key)
      ? record.provider.settings?.[key] as Options
      : matches(record) ? captured.get(record.provider.id)?.options : undefined,
    reconcile: (records) => {
      if (disposed || moving || !records.some((record) =>
        Object.hasOwn(record.provider.settings ?? {}, key) || (captured.has(record.provider.id) && !matches(record)),
      )) return;
      moving = true;
      // Registration order + disposal are public host APIs. Re-register only
      // after observing a source/edit after cleanup, rather than guessing when
      // config is loaded. Disable the old callback before registering the new
      // one so it cannot consume the opt-in first during the next rebuild.
      const old = registration;
      const previousGeneration = generation;
      void register().then(async (next) => {
        registration = next;
        await old.dispose();
        if (disposed) await next.dispose();
      }).catch((error: unknown) => {
        if (registration === old) generation = previousGeneration;
        console.error("[opencode-model-discovery] Provider settings cleanup failed", error);
      }).finally(() => { moving = false; });
    },
    dispose: () => {
      disposed = true;
      captured.clear();
      // The host disposes registrations when the plugin unloads.
    },
  };
}
