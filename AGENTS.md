# AGENTS.md

litellm-to-opencode — fetch LiteLLM models → map into OpenCode provider config

## Essential commands

```
npm run build        # tsc → dist/
npm run dev          # tsx src/index.ts
npm run lint         # eslint src
npm run lint:fix     # eslint src --fix
npm run test         # vitest (watch)
npm run test:run     # vitest run
```

## Architecture

Single-file entrypoint: `src/index.ts`. Tests: `src/index.test.ts`. Build output: `dist/`.

Flow: fetch models from `GET /v1/models` → build provider block using `@ai-sdk/openai-compatible` → merge into `opencode.json` → validate against schema fetched from `https://opencode.ai/config.json`.

### Key exported helpers (for tests)

- `fetchModels(baseURL, apiKey?)` — GET `/v1/models`
- `buildProviderConfig(models, baseURL, apiKey?, providerName)` — maps models to provider block; `providerName` defaults to `"LiteLLM"`
- `mergeProvider(existing, providerKey, providerValue)` — replaces named provider, leaves other keys untouched
- `loadConfig(filePath)` — returns `{ $schema: "https://opencode.ai/config.json" }` for missing/broken files
- `resolveOutputPath({ global, path })` — `~/.config/opencode/opencode.json` / `--path dir/opencode.json` / `./opencode.json`
- `validateConfig(config)` — fetches + caches schema from opencode.ai, validates config; throws on mismatch
- `getOpenCodeConfigSchema()` — returns cached Zod schema compiled from OpenCode JSON Schema
- `resetSchemaCache()` — clears module-level schema cache (test-only)
- `toDisplayName(id)` — `gpt-4o-mini` → `"Gpt 4o Mini"` (strips provider prefix `org/`)
- `sanitizeKey(id)` — keeps `[a-zA-Z0-9\-._/]`, replaces rest with `_`

### Schema validation

The tool fetches and compiles the real OpenCode JSON Schema at runtime via `z.fromJSONSchema()`. External `$ref` values starting with `http` are stripped (Zod only supports local refs). The schema cache is module-level and cached for the process lifetime.

### Provider config

All providers use `@ai-sdk/openai-compatible` adapter with `baseURL + "/v1"`. When a model's sanitized key differs from its original id, the original `id` is preserved as an explicit field (e.g. `my model!` → key `my_model_` with `id: "my model!"`).

## ESLint conventions

- **No explicit `any`** (error)
- **No unused vars** (ignore `_` prefix)
- **Explicit function return types** (warn, allow expressions)
- **Consistent type assertions** (error)
- **prefer-const** (error)

## CLI usage

```
npx tsx src/index.ts --base-url http://localhost:4000 \
  [--api-key sk-...] [--provider-id litellm] [--provider-name LiteLLM] \
  [--global | --path /dir] [--dry-run]
```

`--global` and `--path` are mutually exclusive.

## Test fixtures

Tests mock `fetch` globally via `vi.stubGlobal("fetch", vi.fn())`. A `MOCK_OPENCODE_SCHEMA` constant (defined in the test file) stands in for the remote OpenCode schema. Always `resetSchemaCache()` after tests that modify the fetch mock.
