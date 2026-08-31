# AGENTS.md

opencode-model-discovery - OpenCode plugin for discovering models from OpenAI-compatible providers

## Essential commands

```
npm run build        # type-check + bundle -> dist/opencode-model-discovery.js
npm run lint         # eslint src
npm run lint:fix     # eslint src --fix
npm run test         # vitest (watch)
npm run test:run     # vitest run
```

## Architecture

Plugin entrypoint: `src/index.ts`. Hook implementation: `src/plugin.ts`. Build output: the single bundled file `dist/opencode-model-discovery.js`.

Flow: OpenCode loads the plugin -> the `config` hook finds providers with `options.discovery: true` -> fetches `GET /v1/models` and optional metadata from `GET /v1/model/info` -> merges discovered models into the live provider config. Explicit model entries win.

### Key exports

- `ModelDiscoveryPlugin` - OpenCode plugin function and default export
- `applyDiscovery(config, log?)` - applies discovery to an OpenCode config
- `discoverProviderModels(providerID, provider, log?)` - discovers one opted-in provider

### Provider config

The plugin only touches providers with `options.discovery === true`. `options.baseURL` may include `/v1`. Plugin-only options are removed before OpenCode initializes the AI SDK adapter.

`modelNameFormat` supports `{name}`, `{id}`, and `{provider}` placeholders. Without it, model IDs are normalized into display names.

## ESLint conventions

- **No explicit `any`** (error)
- **No unused vars** (ignore `_` prefix)
- **Explicit function return types** (warn, allow expressions)
- **Consistent type assertions** (error)
- **prefer-const** (error)

## Test fixtures

Tests mock `fetch` globally via `vi.stubGlobal("fetch", vi.fn())`.
