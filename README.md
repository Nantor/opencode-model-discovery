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
        "discovery": true
      }
    }
  }
}
```

The plugin fetches `/v1/models` when OpenCode starts and enriches matching models with metadata from `/v1/model/info`. Manually configured model entries take precedence over discovered entries.

Restart OpenCode after changing plugin or provider configuration.

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

Arrays and objects are inserted as JSON. Placeholders for fields that are not available on a model are left unchanged.

`discovery` and `modelNameFormat` are consumed by the plugin and are not passed to the underlying AI SDK provider.
