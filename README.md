# opencode-model-discovery

An OpenCode plugin that discovers models exposed by OpenAI-compatible providers.

## Installation

Add the plugin and enable discovery on each provider that should be queried:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-model-discovery"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM",
      "options": {
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

Wildcard routes reported by `return_wildcard_routes=true` (e.g. `claude-opus-4-5*`) are kept under their exact route id as reported by `/v1/models`, since LiteLLM's router resolves that literal id back to the deployment behind it. If `/v2/model/info` reports a wildcard route that `/v1/models` did not list, the plugin falls back to surfacing it under its resolved `litellm_params.model` id (e.g. `vertex_ai/claude-opus-4-5@20251101`) so the model is not silently dropped.

That fallback relies on LiteLLM's router accepting a deployment name (`litellm_params.model`) as the request model: when the requested model matches no `model_name` and no wildcard pattern, the router looks for deployments whose `litellm_params.model` equals the request (`Router._get_deployment_by_litellm_model`). This works on a default proxy, but requests may still be rejected if the key or team is restricted to specific model names, or if an access group filter removes the deployment. If a fallback model returns "model not found", ask the proxy operator to expose the route in `/v1/models` or add an explicit model entry with the route id you can call.

Discovery requests time out after 10 seconds by default. Set `discoveryTimeout` to a non-negative number of milliseconds to override it. Discovery and metadata failures are logged but do not prevent OpenCode from starting; existing manually configured models remain available.

By default, discovery requests use the provider's `baseURL`. Set `discoveryBaseURL` when the discovery endpoints are hosted separately from the endpoint used for model requests. It may include `/v1`:

```json
{
  "provider": {
    "gateway": {
      "options": {
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

Set `discoveryCache` to a positive ISO 8601 duration to cache each provider's model list and metadata on disk between OpenCode restarts. For example, `"PT1H"` caches results for one hour, `"P1D"` for one day, and `"P2W"` for two weeks. The cache is disabled by default; invalid or zero durations are logged as a warning and also disable it. Months and years are not supported because their elapsed duration depends on the start date. Cached entries are isolated by endpoint and a hash of the API key, and credentials are not stored in cache files. Cache files live under `$XDG_CACHE_HOME/opencode-model-discovery` (or `~/.cache/opencode-model-discovery`); entries that are expired or malformed are ignored and refetched.

When `/v2/model/info` identifies a model as supporting `max_completion_tokens` but not `max_tokens`, the plugin rewrites only that model's completion limit request parameter. This supports a shared LiteLLM proxy where some routed models, such as Azure deployments, reject `max_tokens`. Models without that exact metadata keep the default `max_tokens` parameter.

Restart OpenCode after changing plugin or provider configuration.

## models.dev Enhancement

LiteLLM's `/v2/model/info` does not always report every field OpenCode understands, such as `family`, `release_date`, `temperature`, or complete `cost`/`limit`/`modalities` data. Set `enhanceFromModelsDev` to `true` to fill those gaps from the public [models.dev](https://models.dev) catalog:

```json
{
  "provider": {
    "litellm": {
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "opencode-model-discovery": {
          "discovery": true,
          "enhanceFromModelsDev": true
        }
      }
    }
  }
}
```

Each discovered model is matched to a models.dev entry using LiteLLM's `litellm_provider` metadata (e.g. `openai`, `azure`, `vertex_ai-anthropic_models`) together with the resolved upstream model id. Only a fixed set of unambiguous provider mappings are used; models routed through a `litellm_provider` without a known mapping are left unmatched rather than guessed. LiteLLM-derived fields always take precedence — models.dev only fills in fields that discovery left `undefined` (for example, adding `family` and `release_date` to a model whose cost and limit were already reported by `/v2/model/info`).

The models.dev catalog is fetched once per discovery run and shared across all providers with `enhanceFromModelsDev` enabled. It respects the same `discoveryCache` and `discoveryTimeout` settings as LiteLLM discovery. A failed or timed-out models.dev fetch is logged as a warning and does not prevent discovery from completing with LiteLLM-only data.

## Resolved Configuration

Use OpenCode's debug command to print the final merged configuration after discovery:

```bash
opencode debug config
```

To save it for inspection:

```bash
opencode debug config > resolved-opencode.json
```

The output includes discovered models, manual overrides, and all inherited OpenCode settings. It can include API keys and other secrets, so do not commit or share it.

## Model Names

Without `modelNameFormat`, model IDs are normalized into display names. For example, `openai/gpt-4o-mini` becomes `Gpt 4o Mini`.

Set `modelNameFormat` to customize display names:

```json
{
  "provider": {
    "litellm": {
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "opencode-model-discovery": {
          "discovery": true,
          "modelNameFormat": "{name} ({provider}/{id})"
        }
      }
    }
  }
}
```

Supported placeholders:

- `{name}`: normalized model name
- `{id}`: effective model ID returned by the provider
- `{provider}`: OpenCode provider ID
- Any `OpenCodeModelEntry` field, using dot notation for nested values. Examples include `{family}`, `{reasoning}`, `{limit.context}`, `{cost.input}`, `{modalities.input}`, and `{options.reasoningSummary}`.

Arrays and objects are inserted as JSON. Placeholders for fields that are not available on a model resolve to an empty string.
Numeric `{limit.*}` placeholders use compact three-significant-digit notation such as `128K` or `1.05M`. Numeric `{cost.*}` placeholders are rounded to two decimal places.

### Conditional Expressions

Use a conditional expression to include text only when model metadata is available:

```
{?path:'text using $0'}
```

The condition is one or more field paths, and the quoted body can reference their values by zero-based position (`$0`, `$1`, and so on). A conditional resolves to an empty string when its condition is not met.

```json
{
  "modelNameFormat": "{name}{?family:' ($0)'}{?limit.context:' - $0 context'}{?reasoning:' [reasoning]'}"
}
```

The example might produce `Gpt 4o (gpt-4o) - 128K context [reasoning]`. Missing fields, `false`, `0`, and empty strings suppress their conditional text.

- Use `&` when every path must be present and truthy: `{?name&family:'$0 ($1)'}`.
- Use `|` when any path may be present and truthy: `{?family|name:'$0$1'}`.
- `$0`, `$1`, and later references retain the position of each listed path. An unavailable value inserts an empty string.
- Escape a literal single quote in the body as `\'`: `{?name:'it\'s $0'}`.
- Do not mix `&` and `|` in one conditional expression.

`discovery`, `discoveryBaseURL`, `discoveryTimeout`, `discoveryCache`, `modelNameFormat`, and `enhanceFromModelsDev` are consumed by the plugin (nested under the `opencode-model-discovery` options key) and are not passed to the underlying AI SDK provider.

Keep provider credentials in environment variables or a secret manager. Do not store live API keys in project environment files or commit them to source control.

## License

This project is licensed under the [MIT License](LICENSE).
