# opencode-model-discovery

An OpenCode plugin that discovers models exposed by OpenAI-compatible providers.

## Installation

Add the plugin and enable discovery on each provider that should be queried:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-model-discovery"],
  "providers": {
    "litellm": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "LiteLLM",
      "settings": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "{env:LITELLM_API_KEY}",
        "opencode-model-discovery": {
          "discovery": true,
          "discoveryTimeout": 10000,
          "discoveryCache": "PT1H"
        }
      }
    }
  }
}
```

The plugin fetches `/v1/models?return_wildcard_routes=true` when OpenCode starts and enriches matching models with metadata from `/v2/model/info?return_wildcard_routes=true`. OpenCode's later configuration overrides take precedence over discovered fields; see [enrichment precedence and V2 provenance limitations](#enrich-existing-models). Provider model IDs are used unchanged as model keys, including spaces and punctuation. Models whose LiteLLM `mode` cannot serve chat completions (embedding, image and video generation, audio, moderation, rerank, OCR, realtime, batch) are skipped.

Model limits map LiteLLM's `max_input_tokens` to `limit.context` and `max_output_tokens` to `limit.output`. LiteLLM's `max_tokens` field is a legacy alias for the output limit and is only used when the dedicated fields are absent.

### Wildcard routes

Discovered model IDs always use `model_name` from matching `/v2/model/info` metadata, never `litellm_params.model` or `model_info.key`. Wildcard routes (e.g. `claude-opus-4-5*`) keep that exact `model_name`, including when `/v1/models` did not list them. Upstream names may be used to match metadata, but do not replace public route IDs. If no matching metadata is available, the plugin keeps the ID reported by `/v1/models` unchanged.

Discovery requests time out after 10 seconds by default. Set `discoveryTimeout` to a non-negative number of milliseconds to override it. Discovery and metadata failures are logged but do not prevent OpenCode from starting; existing manually configured models remain available.

By default, discovery requests use the provider's `baseURL`. Set `discoveryBaseURL` when the discovery endpoints are hosted separately from the endpoint used for model requests. It may include `/v1`:

```json
{
  "providers": {
    "gateway": {
      "settings": {
        "baseURL": "https://inference.example.com/v1",
        "opencode-model-discovery": {
          "discovery": true,
          "discoveryBaseURL": "https://discovery.example.com/v1"
        }
      }
    }
  }
}
```

Discovered models continue to use `baseURL` for inference requests. `baseURL` is always required: discovery is skipped with a warning when only `discoveryBaseURL` is set, because the plugin has no endpoint to hand discovered models to.

Set `discoveryCache` to a positive ISO 8601 duration to cache each provider's model list and metadata in OpenCode plugin storage between OpenCode restarts. For example, `"PT1H"` caches results for one hour, `"P1D"` for one day, and `"P2W"` for two weeks. The cache is disabled by default; invalid or zero durations are logged as a warning and also disable it. Months and years are not supported because their elapsed duration depends on the start date. Cached entries are isolated by endpoint and a hash of the API key, and credentials are not stored in cache entries. Entries that are expired or malformed are ignored, pruned, and refetched.

The plugin sets each discovered model's V2 `compatibility.maxTokensField` from `/v2/model/info`'s `supported_openai_params`: `max_tokens` when only that parameter is supported, or `max_completion_tokens` when it is supported (including when both are listed). This supports shared LiteLLM proxies whose routed models accept different output-token limit parameters. If neither parameter is listed or metadata is missing, the plugin leaves selection to OpenCode's provider/endpoint detection, which uses `max_completion_tokens` for generic gateways. Explicit model compatibility overrides take precedence, including when `enrichExistingModels` is enabled.

Restart OpenCode after changing plugin or provider configuration.

## Plugin Settings

Configure these settings separately for each provider under `providers.<provider-id>.settings["opencode-model-discovery"]`, as shown in the installation example. Discovery is opt-in; providers without `discovery: true` are not queried.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `discovery` | `boolean` | `false` | Enable model discovery for this provider. |
| `discoveryBaseURL` | `string` | Provider's `settings.baseURL` | Override the endpoint used for discovery and metadata requests. May include `/v1`; inference still uses the required provider `baseURL`. |
| `discoveryTimeout` | `number` | `10000` | Timeout in milliseconds for discovery and metadata requests. Must be finite and non-negative; invalid values use the default. |
| `discoveryCache` | `string` | Disabled | Cache model lists and metadata in OpenCode plugin storage for a positive ISO 8601 duration, such as `"PT1H"`, `"P1D"`, or `"P2W"`. Invalid or zero durations disable caching; months and years are not supported. |
| `enrichExistingModels` | `boolean` | `false` | Enrich models with visible overrides, preserving those values including nested fields. Inherited source models are refreshed regardless. See precedence details below. |
| `enhanceFromModelsDev` | `boolean` | `false` | Fill missing non-pricing model metadata from models.dev. See [models.dev Enhancement](#modelsdev-enhancement) for matching and fallback behavior. |
| `modelsDevIgnorePrefixes` | `string[]` | `[]` | Remove the longest matching literal prefix once before models.dev lookup, after stripping the provider path. Only applies when enhancement is enabled. |
| `modelsDevIgnorePostfixes` | `string[]` | `[]` | Remove the longest matching literal postfix once before models.dev lookup. Only applies when enhancement is enabled. |

Prefix and postfix matching is case-sensitive and does not change discovered model keys, request IDs, or display names. Empty or non-string entries are ignored.

The plugin captures these settings separately and removes them from provider settings during registry reconciliation, including for providers registered after the plugin. Provider connection settings such as `baseURL` and `apiKey` belong alongside the `opencode-model-discovery` object, not inside it.

V2 transforms run in registration order and have no post-provider cleanup hook. When the model transform observes a later provider source, the plugin replaces its cleanup registration after that source; the resulting provider/model rebuild uses cleaned settings. A provider-only read before this reconciliation can still expose the plugin settings, and an already-read snapshot is not modified retroactively. This is not a guarantee for runtimes that bypass model-registry reconciliation.

### Enrich existing models

Set `enrichExistingModels: true` alongside `discovery: true` in the provider's `settings["opencode-model-discovery"]`:

```json
{
  "discovery": true,
  "enrichExistingModels": true
}
```

Inherited catalog and plugin source models receive discovered metadata even when `enrichExistingModels` is omitted or `false`. Discovery replaces reported fields and retains source fields it does not supply. Source inventory membership alone does not mean a model was manually configured.

For a source-backed model with visible overrides, `enrichExistingModels: false` skips discovery changes to that model. With `true`, overrides win over discovery, which wins over inherited source fields. For example, a custom `name` is preserved while discovered limits, capabilities, and pricing are added. Nested objects merge field by field: an overridden `limit.output` is preserved while `limit.context` can be refreshed. Values such as `false`, `0`, `null`, and arrays (including empty arrays) are preserved; arrays are not combined. Models absent from discovery are left as configured. Enable `enhanceFromModelsDev` as well to include its non-pricing metadata.

**V2 provenance limitation:** the editor exposes source definitions and current model drafts, not original user configuration. The plugin identifies visible overrides by comparing the draft with its source. An override already folded into a source, or equal to its source value, cannot be distinguished from inheritance and may be refreshed. OpenCode's later configuration transform applies actual configured values afterward, so those values win regardless of this setting; a config entry first applied later cannot trigger the earlier whole-model skip. The exported config-style helpers receive actual configured entries and therefore preserve those entries directly.

## models.dev Enhancement

LiteLLM's `/v2/model/info` does not always report every field OpenCode understands, such as `family`, token limits, or complete input/output capabilities. Set `enhanceFromModelsDev` to `true` to fill those non-pricing gaps directly from `https://models.dev/models.json`, fetched using the official `@opencode-ai/models` client. Enrichment uses OpenCode's `Model.Info` types and maps tool calling, modalities, and reasoning compatibility to runtime fields before applying OpenCode defaults. Fields without a runtime equivalent (`temperature`, `attachment`, and `knowledge`) are not copied; release-date enrichment is also omitted. The plugin does not read OpenCode's cached catalog. Pricing is never copied from this catalog:

```json
{
  "providers": {
    "litellm": {
      "settings": {
        "baseURL": "http://localhost:4000/v1",
        "opencode-model-discovery": {
          "discovery": true,
          "enhanceFromModelsDev": true,
          "modelsDevIgnorePrefixes": ["US-", "EU-"],
          "modelsDevIgnorePostfixes": ["-private", "-preview-route"]
        }
      }
    }
  }
}
```

The remote catalog is a flat map of provider-independent metadata keyed by canonical model ID (for example, `openai/gpt-4o`). Each discovered model is matched using its defined model ID with any provider prefix stripped (and configured `modelsDevIgnorePrefixes` / `modelsDevIgnorePostfixes` removed) against the provider-stripped catalog model ID (`gpt-4o`). Matching is exact and case-sensitive, and ignores LiteLLM provider metadata. If several entries match, the first in catalog order wins. LiteLLM-derived fields always take precedence — catalog data only fills in non-pricing fields that discovery left `undefined`, including a missing `limit.input`. Costs remain sourced from LiteLLM discovery or explicit model configuration, never from `models.json`. Requests time out after 10 seconds; if the catalog is unavailable or invalid, the plugin logs a warning and falls back to the bundled `@opencode-ai/models/snapshot` canonical models (the fallback build). The snapshot reflects the installed package version and requires no network request. If the snapshot also cannot be loaded, or the plugin was built as the slim variant (which omits the bundled snapshot to keep the bundle small), discovery continues without enhancement.

Models with endpoint-only modes such as `mode: "image_generation"` in `/models` or `/v2/model/info` are excluded from discovery. The `/models` exclusion also applies when detailed model info is unavailable or reports a different mode.

Use `modelsDevIgnorePrefixes` and `modelsDevIgnorePostfixes` to remove gateway-specific affixes before catalog ID lookup when `enhanceFromModelsDev` is enabled. For example, `EU-gpt-4o-private` can match `gpt-4o` or `openai/gpt-4o` with the settings above. The longest matching prefix and postfix are each removed once after stripping any leading provider path, using case-sensitive literal matching (not regular expressions). Empty or non-string entries are ignored, and an empty cleaned ID never matches. These options do not change discovered model keys, request IDs, or display names.

## Debugging Provider Configuration

Use OpenCode V2's API command to inspect the configuration sources for the current directory:

```bash
opencode api get /api/config
```

To save it for inspection:

```bash
opencode api get /api/config > opencode-config-entries.json
```

OpenCode V2 returns configuration documents and discovery directories in priority order (lowest to highest), not a merged runtime model inventory. The documents include configured model overrides and inherited OpenCode settings. They can include API keys and other secrets, so do not commit or share the output.

To inspect the unprocessed LiteLLM responses alongside the merged configuration for one provider, run:

```bash
npm run debug:provider -- litellm
```

The command requires OpenCode V2. It calls `opencode api get /api/config` for the current directory and merges the returned configuration documents in priority order, including global and project settings. It reads the selected provider from `providers` and its options from `settings`. It uses `settings["opencode-model-discovery"].discoveryBaseURL` when configured (otherwise `settings.baseURL`), sends `settings.apiKey`, and writes the raw `/v1/models`, raw `/v2/model/info`, and a reduced configuration containing only `$schema` (when present) and the selected `providers` entry to `debug/<provider-id>.*.json`. It also writes `debug/<provider-id>.models.csv`, which lists every model ID and whether it was found in `/v1/models`, `/v2/model/info`, the merged provider configuration, or the `@opencode-ai/models` catalog (`models_dev`, matched by model ID without provider and any configured `modelsDevIgnorePrefixes` / `modelsDevIgnorePostfixes`). The `config` column describes configured models, not the plugin's runtime-discovered inventory. Its `config_name_only` column is true when the configuration entry contains only a `name`. These files can include API keys, model metadata, and other secrets; do not commit or share them.

For the compiled runtime view, the debug script separately queries `opencode api get /api/provider/<provider-id>` and `opencode api get /api/model`. It combines the resolved provider settings and that provider's models into `debug/<provider-id>.opencode-runtime.json` and adds a `runtime` column to the CSV. This preserves the distinction between configured overrides (`config`) and models currently available after runtime transforms (`runtime`). V2's model API returns a snapshot that may precede initial plugin discovery settlement; rerun the script after discovery completes if expected models are missing. Runtime output can also contain secrets and must not be committed or shared.

The debug script uses the plugin's URL normalization and timeout validation. If optional `/v2/model/info` fails, it warns and saves an error object in `.model-info.json` while retaining the model list, configuration, and CSV. In this case, `model_info=false` means detailed info was unavailable, not confirmed model absence. If runtime inspection fails, it saves an error marker in `.opencode-runtime.json` and writes the CSV without a `runtime` column. The runtime output otherwise preserves enriched capabilities, reasoning compatibility, and cost tiers as returned by OpenCode, including metadata from the catalog snapshot fallback.

The script also writes `debug/<provider-id>.models-dev.json`, keyed by each model ID appearing in discovery, configuration, or runtime inventory (the same set as the CSV). Each value is the complete matching models.dev metadata entry, using the configured prefix/postfix matching rules, or `{}` when no match or catalog data is available.

## Model Names

Model IDs are normalized into display names. For example, `openai/gpt-4o-mini` becomes `Gpt 4o Mini`.

Keep provider credentials in environment variables or a secret manager. Do not store live API keys in project environment files or commit them to source control.

## Build Variants

`npm run build` emits two self-contained bundles into `dist/`:

- `opencode-model-discovery.js` — the **fallback** build. It bundles the `@opencode-ai/models/snapshot` canonical catalog (~6.7 MB) used when the live `models.dev` fetch is unavailable. `main`/`exports` point here, so this is the default published variant and is backwards compatible.
- `opencode-model-discovery-slim.js` — the **slim** build (~0.8 MB). It omits the bundled snapshot; when the live `models.dev` catalog cannot be fetched, the plugin logs a warning and continues discovery without enhancement.

Both files ship in the published package (`files` includes `dist`). To build a single variant instead of both, use `npm run build:fallback` or `npm run build:slim`.

The variant is selected at build time by the esbuild `--define` flag `BUILD_SNAPSHOT` (`true` for fallback, `false` for slim); the code between the two is identical apart from that single compile-time toggle.

`npm run deploy:local` installs the built plugin into the local OpenCode plugins directory and restarts the service. It deploys the **slim** variant by default; pass `--variant=fallback` to deploy the fallback build instead:

```bash
npm run deploy:local                 # slim (default)
npm run deploy:local -- --variant=fallback
```

## License

This project is licensed under the [MIT License](LICENSE).
