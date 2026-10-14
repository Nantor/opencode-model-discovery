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

The plugin fetches `/v1/models?return_wildcard_routes=true` when OpenCode starts and enriches matching models with metadata from `/v2/model/info?return_wildcard_routes=true`. Manually configured model entries take precedence over discovered entries. Provider model IDs are used unchanged as model keys, including spaces and punctuation. Models whose LiteLLM `mode` cannot serve chat completions (embedding, image and video generation, audio, moderation, rerank, OCR, realtime, batch) are skipped.

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

When `/v2/model/info` identifies a model as supporting `max_completion_tokens` but not `max_tokens`, the plugin rewrites only that model's completion limit request parameter. This supports a shared LiteLLM proxy where some routed models, such as Azure deployments, reject `max_tokens`. Models without that exact metadata keep the default `max_tokens` parameter.

Restart OpenCode after changing plugin or provider configuration.

## models.dev Enhancement

LiteLLM's `/v2/model/info` does not always report every field OpenCode understands, such as `family`, `release_date`, `temperature`, or complete `limit`/`modalities` data. Set `enhanceFromModelsDev` to `true` to fill those non-pricing gaps from OpenCode's local models.dev catalog at `~/.cache/opencode/models.json`. Pricing is never copied from this catalog:

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

The local catalog groups models by provider: each provider entry contains a `models` map. Each discovered model is matched using its resolved upstream model ID (`litellm_params.model`, or the discovered model name if absent). After removing configured prefixes and postfixes, the plugin searches every provider's models for the first model whose `id` ends with the cleaned ID. Matching is case-sensitive and ignores LiteLLM provider metadata. If several entries match, the first in catalog order wins. LiteLLM-derived fields always take precedence — catalog data only fills in non-pricing fields that discovery left `undefined` (for example, adding `family` and `release_date` to a model whose cost and limit were already reported by `/v2/model/info`). Costs remain sourced from LiteLLM discovery or explicit model configuration, never from `models.json`.

The local catalog is maintained by OpenCode. If it is unavailable or malformed, the plugin logs a warning and discovery continues with LiteLLM-only data.

Models with endpoint-only modes such as `mode: "image_generation"` in `/models` or `/v2/model/info` are excluded from discovery. The `/models` exclusion also applies when detailed model info is unavailable or reports a different mode.

Use `modelsDevIgnorePrefixes` and `modelsDevIgnorePostfixes` to remove gateway-specific affixes before catalog ID lookup when `enhanceFromModelsDev` is enabled. For example, `EU-gpt-4o-private` can match `gpt-4o` or `openai/gpt-4o` with the settings above. The longest matching prefix and postfix are each removed once, using case-sensitive literal matching (not regular expressions). Empty or non-string entries are ignored, and an empty cleaned ID never matches. No provider path or regional prefix is stripped automatically; include it in the prefix settings if needed. These options do not change discovered model keys, request IDs, or display names.

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

The command requires OpenCode V2. It calls `opencode api get /api/config` for the current directory and merges the returned configuration documents in priority order, including global and project settings. It reads the selected provider from `providers` and its options from `settings`. It uses `settings["opencode-model-discovery"].discoveryBaseURL` when configured (otherwise `settings.baseURL`), sends `settings.apiKey`, and writes the raw `/v1/models`, raw `/v2/model/info`, and a reduced configuration containing only `$schema` (when present) and the selected `providers` entry to `debug/<provider-id>.*.json`. It also writes `debug/<provider-id>.models.csv`, which lists every model ID and whether it was found in `/v1/models`, `/v2/model/info`, or the merged provider configuration. The `config` column describes configured models, not the plugin's runtime-discovered inventory. Its `config_name_only` column is true when the configuration entry contains only a `name`. These files can include API keys, model metadata, and other secrets; do not commit or share them.

For the compiled runtime view, the debug script separately queries `opencode api get /api/provider/<provider-id>` and `opencode api get /api/model`. It combines the resolved provider settings and that provider's models into `debug/<provider-id>.opencode-runtime.json` and adds a `runtime` column to the CSV. This preserves the distinction between configured overrides (`config`) and models currently available after runtime transforms (`runtime`). V2's model API returns a snapshot that may precede initial plugin discovery settlement; rerun the script after discovery completes if expected models are missing. Runtime output can also contain secrets and must not be committed or shared.

## Model Names

Model IDs are normalized into display names. For example, `openai/gpt-4o-mini` becomes `Gpt 4o Mini`.

`discovery`, `discoveryBaseURL`, `discoveryTimeout`, `discoveryCache`, `enhanceFromModelsDev`, `modelsDevIgnorePrefixes`, and `modelsDevIgnorePostfixes` are consumed by the plugin (nested under the `opencode-model-discovery` settings key) and are not passed to the underlying provider runtime.

Keep provider credentials in environment variables or a secret manager. Do not store live API keys in project environment files or commit them to source control.

## License

This project is licensed under the [MIT License](LICENSE).
