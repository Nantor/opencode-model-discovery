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
        "discovery": true,
        "discoveryTimeout": 10000
      }
    }
  }
}
```

The plugin fetches `/v1/models` when OpenCode starts and enriches matching models with metadata from `/v1/model/info`. Manually configured model entries take precedence over discovered entries. Provider model IDs are used unchanged as model keys, including spaces and punctuation.

Discovery requests time out after 10 seconds by default. Set `discoveryTimeout` to a non-negative number of milliseconds to override it. Discovery and metadata failures are logged but do not prevent OpenCode from starting; existing manually configured models remain available.

Restart OpenCode after changing plugin or provider configuration.

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
        "discovery": true,
        "modelNameFormat": "{name} ({provider}/{id})"
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

`discovery`, `discoveryTimeout`, and `modelNameFormat` are consumed by the plugin and are not passed to the underlying AI SDK provider.

Keep provider credentials in environment variables or a secret manager. Do not store live API keys in project environment files or commit them to source control.

## License

This project is licensed under the [MIT License](LICENSE).
