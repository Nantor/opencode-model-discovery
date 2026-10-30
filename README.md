# opencode-model-discovery

An OpenCode V2 plugin that discovers models exposed by OpenAI-compatible providers. Development and source-script commands require Node.js 24 or newer.

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

When the model registry first sees an opted-in provider, the plugin asynchronously fetches `/v1/models?return_wildcard_routes=true` and enriches matching models with metadata from `/v2/model/info?return_wildcard_routes=true`, reusing valid cached responses when enabled. It then requests a model-registry reload to publish the results. OpenCode's later configuration overrides take precedence over discovered fields; see [enrichment precedence and V2 provenance limitations](#enrich-existing-models). Provider model IDs are used unchanged as model keys, including spaces and punctuation. Models whose LiteLLM `mode` cannot serve chat completions (embedding, image and video generation, audio, moderation, rerank, OCR, realtime, batch) are skipped.

Model limits map LiteLLM's `max_input_tokens` to `limit.context` and `limit.input`, and `max_output_tokens` to `limit.output`. LiteLLM's `max_tokens` is only an output fallback when `max_output_tokens` is missing or invalid; it never supplies context. Independently reported limits are preserved before catalog enhancement and host defaults.

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

Provider-level `headers` are sent to both discovery endpoints and by `debug:provider`, including when `discoveryBaseURL` is set. Explicit headers override defaults case-insensitively: an `Authorization` header overrides the bearer token derived from `settings.apiKey`. If multiple configured names differ only in casing, the last entry wins. Effective request headers are hashed for cache isolation, so changing authentication or tenant-routing headers cannot reuse another scope's inventory; configured header values are not stored as cache identity.

Set `discoveryCache` to a positive ISO 8601 duration to cache each provider's model list and metadata in durable OpenCode plugin storage across plugin reloads and server restarts. For example, `"PT1H"` caches results for one hour, `"P1D"` for one day, and `"P2W"` for two weeks. The cache is disabled by default; invalid or zero durations are logged as a warning and also disable it. Months and years are not supported because their elapsed duration depends on the start date.

Expired entries are treated as misses and their best-effort removal is awaited before refetching. Malformed cache envelopes or invalid cached values are misses without removal: a successful fetch and cache write can overwrite them, while a failed refetch leaves them stored. Detailed metadata arrays are handled record by record, retaining usable entries and discarding malformed records without refetching the whole array. There is no background pruning sweep.

Cache keys hash the complete configured discovery base URL string (including any userinfo and query) and effective request headers. V2 also includes a hash of the provider/source settings identity, including `sourceConnection`. This isolates endpoint, authentication, and tenant scope without storing those connection values as plaintext cache keys. URL hashing is an identity safeguard, not support for userinfo/query authentication: request URLs are constructed by appending endpoint paths, so use `settings.apiKey` or provider `headers` for credentials. Cached responses contain only allowlisted fields used by discovery: model/alias IDs, modes, validated limits, pricing, capability flags, interleaved reasoning, and output-token parameter compatibility. Arbitrary response extras, including credential fields in `litellm_params` and `model_info`, are excluded. Model/alias IDs and modes are retained as supplied; do not put secrets in these discovery fields. These guarantees cover the plugin's cache projection, not raw debug files or error logs.

The `discovery:v2:` cache namespace invalidates older raw-response caches and refetches metadata. Old entries are not read, migrated, or automatically deleted; they may still contain previously cached credentials or plaintext URLs until removed separately from this plugin's OpenCode storage. Upgrading does not retroactively sanitize stored data.

The plugin sets each discovered model's V2 `compatibility.maxTokensField` from `/v2/model/info`'s `supported_openai_params`: `max_tokens` when only that parameter is supported, or `max_completion_tokens` when it is supported (including when both are listed). This supports shared LiteLLM proxies whose routed models accept different output-token limit parameters. If neither parameter is listed or metadata is missing, the plugin leaves selection to OpenCode's provider/endpoint detection, which uses `max_completion_tokens` for generic gateways. Explicit model compatibility overrides take precedence, including when `enrichExistingModels` is enabled.

### Reloading and discovery refresh

OpenCode V2 [automatically reloads watched configuration and plugin files](https://opencode.ai/v2/docs/plugins#reload). Use `/reload` in the TUI or [`opencode reload`](https://opencode.ai/v2/docs/cli/commands#reload) for a full configuration reload without restarting the server. Changes to unwatched plugin dependencies can require a service restart; ordinary plugin/provider configuration edits do not.

Configuration reload and discovery refresh are distinct:

- On a model-transform replay, changes to the host's provider settings, headers, provider metadata, or source connection invalidate the previous discovery attempt. The remote inventory itself is not watched. Disabling discovery or removing the provider stops publishing that inventory. Superseded attempts cannot publish late results.
- With a positive `discoveryCache`, successful in-memory inventory becomes eligible for refresh on a later replay after that duration (at least one second after success). Each persisted endpoint response has its own cache timestamp and may still be reused if valid. Without a valid duration, successful inventory is retained for unchanged inputs for the life of the plugin instance.
- Whole-provider failures retry on a later replay after exponential backoff from one second up to one minute. Optional metadata failure still counts as successful basic discovery and follows the success refresh rules. No timer triggers requests or retries.

The [V2 transform API](https://opencode.ai/v2/docs/build/plugins/server#transforms) replays transforms after registration changes or a domain reload; an ordinary read may reuse an unchanged registry. `ctx.model.reload()` does not rerun plugin setup or bypass the discovery cache. To force a network refetch, remove `discoveryCache`, save and reload the configuration, and let discovery settle before restoring it. If caching was already disabled and inputs are unchanged, disable the plugin with a later `"-opencode-model-discovery"` entry in `plugins`, let it unload, then remove that disabling entry to create a fresh instance. The plugin exposes no separate refresh command.

Initial discovery and refresh are asynchronous. Discovery-only models can be absent while a new attempt is pending or failed; the plugin does not retain the old inventory during refresh. Source/configured models remain governed by OpenCode's registry and overrides. Previously returned API snapshots are not updated in place. Discovery cannot make an unavailable provider active.

## Plugin Settings

Configure these settings separately for each provider under `providers.<provider-id>.settings["opencode-model-discovery"]`, as shown in the installation example. Discovery is opt-in; providers without `discovery: true` are not queried.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `discovery` | `boolean` | `false` | Enable model discovery for this provider. |
| `discoveryBaseURL` | `string` | Provider's `settings.baseURL` | Override the endpoint used for discovery and metadata requests. May include `/v1`; inference still uses the required provider `baseURL`. |
| `discoveryTimeout` | `number` | `10000` | Timeout in milliseconds for discovery and metadata requests. Must be finite and non-negative; invalid values use the default. |
| `discoveryCache` | `string` | Disabled | Cache model lists and metadata for a positive ISO 8601 duration, such as `"PT1H"`, `"P1D"`, or `"P2W"`; also enables refresh eligibility on later registry replays. Invalid or zero durations disable caching; months and years are not supported. |
| `enrichExistingModels` | `boolean` | `false` | Enrich models with visible overrides, preserving those values including nested fields. Inherited source models are refreshed regardless. See precedence details below. |
| `enhanceFromModelsDev` | `boolean` | `false` | Fill missing non-pricing model metadata from models.dev. See [models.dev Enhancement](#modelsdev-enhancement) for matching and fallback behavior. |
| `modelsDevIgnorePrefixes` | `string[]` | `[]` | Remove the longest matching literal prefix once before models.dev lookup, after stripping the provider path. Only applies when enhancement is enabled. |
| `modelsDevIgnorePostfixes` | `string[]` | `[]` | Remove the longest matching literal postfix once before models.dev lookup. Only applies when enhancement is enabled. |

Prefix and postfix matching is case-sensitive and does not change discovered model keys, request IDs, or display names. Empty or non-string entries are ignored.

The plugin captures these settings separately and removes them from provider settings during registry reconciliation, including for providers registered after the plugin. Provider connection settings such as `baseURL` and `apiKey` belong alongside the `opencode-model-discovery` object, not inside it.

V2 transforms run in registration order and have no post-provider cleanup hook. When the model transform observes a later provider source or edit, the plugin replaces its cleanup registration after that source; the resulting provider/model rebuild uses cleaned settings. This depends on model-registry reconciliation after provider invalidation and preservation of the cleaned settings reference in host snapshots. A provider-only read before reconciliation can still expose the plugin settings, and an already-read snapshot is not modified retroactively.

The lockfile currently uses `@opencode/plugin`, `@opencode/schema`, and `@opencode/ai` **2.2.3**. The lifecycle tests simulate the provider/model editor contract; they are not an end-to-end test of a running OpenCode server. The installed editor API exposes neither a final provider-cleanup phase nor original user-config provenance, so the cleanup and precedence boundaries described here remain relevant even when unit tests pass.

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

For models without a source definition, existing raw fields from earlier model transforms win regardless of `enrichExistingModels`; discovery fills missing fields and the host supplies defaults afterward.

## models.dev Enhancement

LiteLLM's `/v2/model/info` does not always report every field OpenCode understands, such as `family`, token limits, or complete input/output capabilities. Set `enhanceFromModelsDev` to `true` to fill those non-pricing gaps directly from `https://models.dev/models.json`, fetched using the official `@opencode-ai/models` client. Enrichment uses OpenCode's `Model.Info` types and maps tool calling, modalities, and reasoning compatibility to runtime fields before the host applies defaults. This plugin does not copy catalog `temperature`, `attachment`, `knowledge`, or release-date fields. The plugin does not read OpenCode's cached catalog. Pricing is never copied from this catalog:

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

The remote catalog is a flat map of provider-independent metadata keyed by canonical model ID (for example, `openai/gpt-4o`). Each discovered model is matched using its defined model ID with any provider prefix stripped (and configured `modelsDevIgnorePrefixes` / `modelsDevIgnorePostfixes` removed) against the provider-stripped catalog model ID (`gpt-4o`). Matching is exact and case-sensitive, and ignores LiteLLM provider metadata. If several entries match, the first in catalog order wins. LiteLLM-derived values always take precedence: catalog data fills missing non-pricing fields, including a missing `limit.input`, and unreported individual modalities. Explicit modality flags, including `false`, constrain catalog enrichment. Costs remain sourced from LiteLLM discovery or explicit model configuration, never from `models.json`. Requests time out after 10 seconds; if the catalog is unavailable or invalid, the plugin logs a warning and falls back to the bundled `@opencode-ai/models/snapshot` canonical models (the fallback build). The snapshot reflects the installed package version and requires no network request. If the snapshot also cannot be loaded, or the plugin was built as the slim variant (which omits the bundled snapshot to keep the bundle small), discovery continues without enhancement.

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

The debug command fetches discovery directly, independently of the plugin's opt-in and cache; it does not refresh the runtime inventory. It always attempts the catalog lookup, using the installed snapshot when the live catalog fails in this unbundled Node execution path. If both sources fail, the CSV omits `models_dev` and the catalog summary contains empty objects. Provider and model API requests are separate snapshots, so rerunning after reconciliation may also be necessary to see cleaned provider settings.

## Model Names

Model IDs are normalized into display names. For example, `openai/gpt-4o-mini` becomes `Gpt 4o Mini`.

Keep provider credentials in environment variables or a secret manager. Do not store live API keys in project environment files or commit them to source control.

## Build Variants

`npm run build` emits two self-contained bundles into `dist/`:

- `opencode-model-discovery.js` — the **fallback** build. It bundles the `@opencode-ai/models/snapshot` canonical catalog used when the live `models.dev` fetch is unavailable. `main`/`exports` point here, so this is the default published V2 variant.
- `opencode-model-discovery-slim.js` — the **slim** build. It omits the bundled snapshot; when the live `models.dev` catalog cannot be fetched, the plugin logs a warning and continues discovery without enhancement.

Both files ship in the published package (`files` includes `dist`). To build a single variant instead of both, use `npm run build:fallback` or `npm run build:slim`.

The variant is selected by esbuild's `define` option in `scripts/build.mjs`: `BUILD_SNAPSHOT` is `true` for fallback and `false` for slim. Single-variant build commands clean `dist/` first, so only the selected artifact remains.

`npm run deploy:local` builds the selected variant, copies it to `~/.config/opencode/plugins/`, and explicitly runs `opencode service restart`. That restart is a side effect of this development script, not a requirement for V2 hot reload. The script uses this fixed global directory rather than resolving `XDG_CONFIG_HOME`, and leaves existing plugin files there in place. It deploys the **slim** variant by default; pass `--variant=fallback` to deploy the fallback build instead:

```bash
npm run deploy:local                 # slim (default)
npm run deploy:local -- --variant=fallback
```

## License

This project is licensed under the [MIT License](LICENSE).
