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

The plugin fetches `/v1/models?return_wildcard_routes=true` when OpenCode starts and enriches matching models with metadata from `/v2/model/info?return_wildcard_routes=true`. Manually configured model entries take precedence over discovered entries. Provider model IDs are used unchanged as model keys, including spaces and punctuation. Wildcard routes reported by `return_wildcard_routes=true` (e.g. `claude-opus-4-5*`) are kept under their exact route id as reported by `/v1/models`, since LiteLLM's router resolves that literal id back to the deployment behind it. If `/v2/model/info` reports a wildcard route that `/v1/models` did not list, the plugin falls back to surfacing it under its resolved `litellm_params.model` id so the model is not silently dropped.

Discovery requests time out after 10 seconds by default. Set `discoveryTimeout` to a non-negative number of milliseconds to override it. Discovery and metadata failures are logged but do not prevent OpenCode from starting; existing manually configured models remain available.

Set `discoveryCache` to a positive ISO 8601 duration to cache each provider's model list and metadata on disk between OpenCode restarts. For example, `"PT1H"` caches results for one hour, `"P1D"` for one day, and `"P2W"` for two weeks. The cache is disabled by default for invalid or zero durations. Months and years are not supported because their elapsed duration depends on the start date. Cached entries are isolated by endpoint and a hash of the API key, and credentials are not stored in cache files.

When `/v2/model/info` identifies a model as supporting `max_completion_tokens` but not `max_tokens`, the plugin rewrites only that model's completion limit request parameter. This supports a shared LiteLLM proxy where some routed models, such as Azure deployments, reject `max_tokens`. Models without that exact metadata keep the default `max_tokens` parameter.

Restart OpenCode after changing plugin or provider configuration.

## System Test

Create an untracked `test.env` containing `baseUrl` and `apiKey`, then run:

```bash
npm run test:system
```

To run one discovered model, set `SYSTEM_TEST_MODEL`:

```bash
SYSTEM_TEST_MODEL=US-gpt-6-astra npm run test:system
```

The system-test launcher starts OpenCode with a temporary inline configuration that loads this plugin and discovers every model exposed by that LiteLLM endpoint. It then registers one Vitest case per discovered model; each invokes `opencode run` with `Return just 1`, forces OpenCode's output budget to one token, and expects exactly `1`. Each model has a five-minute execution limit; set `SYSTEM_TEST_TIMEOUT_MS` to override it. This exercises OpenCode's plugin loading, discovery hook, AI SDK adapter, and request transform, including the discovered `max_completion_tokens` compatibility handling. The launcher exits successfully without running tests when `test.env` is absent or does not define both variables.

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

`discovery`, `discoveryTimeout`, `discoveryCache`, and `modelNameFormat` are consumed by the plugin (nested under the `opencode-model-discovery` options key) and are not passed to the underlying AI SDK provider.

Keep provider credentials in environment variables or a secret manager. Do not store live API keys in project environment files or commit them to source control.

## License

This project is licensed under the [MIT License](LICENSE).
