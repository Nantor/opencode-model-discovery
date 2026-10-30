# AGENTS.md

opencode-model-discovery - OpenCode plugin for discovering models from OpenAI-compatible providers

## Essential commands

```sh
npm run build        # type-check + build both fallback and slim bundles in dist/
npm run build:fallback # clean dist/, type-check, build fallback only
npm run build:slim   # clean dist/, type-check, build slim only
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src
npm run lint:fix     # eslint src --fix
npm run test         # vitest src scripts (watch)
npm run test:run     # vitest run src scripts
npm run test:host    # build + actual OpenCode 2.2.3 smoke (OPENCODE_SMOKE_BINARY overrides CLI)
npm run debug:provider -- <provider-id> # query V2 config/runtime APIs and discovery endpoints
```

## Architecture

V2 entrypoint: `src/index.ts` defaults to `Plugin.define({ id, setup: ModelDiscoveryPlugin })`. Setup in `src/plugin.ts` registers synchronous provider/model transforms and returns unload cleanup. `scripts/build.mjs` bundles `dist/opencode-model-discovery.js` (default export target, with catalog snapshot fallback) and `dist/opencode-model-discovery-slim.js` (without snapshot). Both are Node 24 ESM bundles.

Flow: provider transform captures plugin settings and cleans provider drafts -> model transform reads provider sources and starts asynchronous discovery -> fetches `GET /v1/models?return_wildcard_routes=true` and optional `GET /v2/model/info?return_wildcard_routes=true` -> filters endpoint-only modes -> optionally enhances from models.dev -> stores partial V2 model drafts -> calls `ctx.model.reload()` to publish them on replay. OpenCode 2.2.3 initializes new model callbacks with `Model.Info.default()`; discovery replaces reported defaults while retaining visible earlier edits and unreported defaults. Discovery cannot activate an unavailable provider.

Module map:

- `src/plugin.ts`: discovery orchestration, per-provider lifecycle state, V2 bridge, and legacy config-style helpers. A `WeakMap` retains partial runtime drafts alongside legacy model entries.
- `src/provider-settings.ts`: private settings capture and cleanup registration reconciliation.
- `src/fetch.ts`: URL normalization, effective headers, timeouts/cancellation, response guards.
- `src/provider.ts`: LiteLLM mapping, including independent token limits and modality flags.
- `src/model.ts`: V2 draft conversion and source-versus-visible-override comparison; materialization helper used by tests.
- `src/models-dev.ts` / `src/models-dev-snapshot.ts`: non-pricing catalog enhancement and snapshot fallback. Unbundled Node defaults to the installed snapshot; slim builds omit it.
- `src/cache.ts`: duration parsing, hashed keys, allowlisted response projections, plugin storage, and paginated memory storage.
- `src/types.ts` / `src/utils.ts`: partial V2 and legacy types, validation, merge, display-name, and sort helpers.

Limits: `max_input_tokens` supplies `limit.context` and `limit.input`; `max_output_tokens` supplies `limit.output`, falling back to `max_tokens` only for output. Preserve partial limits and explicit negative capabilities through enhancement. V2 output-token encoding uses `compatibility.maxTokensField`.

### Key exports

- Default export: the V2 plugin definition object, not the setup function.
- `ModelDiscoveryPlugin(ctx)`: asynchronous V2 setup; resolves to an unload cleanup function.
- `applyDiscovery(config, log?, storage?)`: mutates the legacy `config.provider` / provider `options` shape, not native V2 `providers` / `settings`.
- `discoverProviderModels(providerID, provider, log?, storage?, lifecycle?)`: mutates one legacy-shaped provider; V2 setup uses it with a temporary wrapper and internal cancellation/fingerprint context.
- `createMemoryStorage()` and type `Storage`: in-memory implementation of the V2 plugin storage contract, including prefix/cursor pagination; production uses `ctx.storage`.

The config-style helpers are a compatibility boundary, not V2 hooks. Their models use legacy fields such as `tool_call`, `modalities`, and complete `limit` objects; they cannot expose all partial V2 metadata. Their `transformRequestBody` shim is for the legacy AI SDK path and is not installed into V2 runtime settings. Actual configured entries win in those helpers; `enrichExistingModels` fills their missing fields.

### Provider config

Native V2 configuration uses `providers.<id>.settings["opencode-model-discovery"]`. Only `discovery === true` starts discovery. `settings.baseURL` is required and may include `/v1`; `discoveryBaseURL` overrides discovery only. Provider-level `headers` and `settings.apiKey` authenticate discovery. Plugin settings are captured and removed during reconciliation even when discovery is disabled.

Provider/model transforms replay in registration order. If a provider source or edit arrives after cleanup, `src/provider-settings.ts` replaces its cleanup registration after that source. This relies on provider invalidation causing model reconciliation, and on the host preserving the cleaned settings reference into provider snapshots. A provider-only read before reconciliation can expose plugin settings; already-returned snapshots are never repaired retroactively. There is no post-provider cleanup hook in the installed API.

Inherited source models receive discovered fields; source presence is not user-config provenance. Visible overrides are draft fields differing from source: with enrichment disabled they skip that source-backed model, and with enrichment enabled they win over discovery, then source. For models without a source, fields differing from `Model.Info.default()` win over discovery regardless of enrichment; discovery wins over remaining host defaults. Equal-to-default earlier edits (including `cost: []` and `tools: true`), equal-to-source edits, or source-folded overrides cannot be identified. The host's later configuration transform still wins, including equal-value settings; entries first applied there cannot cause an earlier whole-model skip.

### Lifecycle and cache

V2 watches configuration/plugin files and supports `/reload` or `opencode reload`; service restarts are not required for ordinary config edits. Domain `ctx.model.reload()` replays transforms without rerunning setup. Discovery fingerprints provider metadata/settings/headers and `sourceConnection`; changed inputs, opt-out, removal, or unload invalidate state and reject superseded results.

Successful inventory persists in memory for unchanged inputs. A positive `discoveryCache` duration also makes it eligible for refresh on a later replay (minimum one second after success); without it there is no timed refresh. Failed discovery retries only on a later replay after exponential backoff (1–60 seconds). There is no timer or standalone refresh command. A registry read alone need not replay an unchanged registry. Optional metadata failure is a successful basic discovery, not a retryable whole-provider failure. See README's lifecycle section for forced refetch and snapshot behavior.

Durable cache entries use `discovery:v2:` with hashed endpoint/header identity and an additional V2 source/settings fingerprint. Only allowlisted response fields are persisted; retained model/alias IDs and modes are not secret-redacted. Older namespaces are not read, migrated, or deleted. Expired entries are removed best-effort and awaited before refetch; malformed envelopes/invalid values are misses without removal and may be overwritten on a successful fetch/write. Cached metadata arrays keep usable entries and discard malformed records without forcing refetch. HTTP and cached metadata share field-by-field sanitization: null/invalid optional fields do not discard valid exclusion modes, aliases, limits, or capabilities; parameter arrays retain string elements. No background storage sweep occurs.

### API and verification boundary

The lockfile currently installs `@opencode/plugin`, `@opencode/schema`, and `@opencode/ai` 2.2.3. Inspect the installed implementation as well as declarations/encoder when changing integration behavior: the raw-override documentation does not mean callbacks receive empty models. Lifecycle tests replay simulated editors. `npm run test:host` additionally verifies new/source-backed metadata, partial fields, earlier policy edits and later native config in a real 2.2.3 private server, using isolated HOME/XDG/database paths and loopback HTTP. It retains artifacts under `/tmp/opencode/model-discovery-host-*` (override with `OPENCODE_SMOKE_TMP`) and requires the exact supported CLI version. F07 cleanup convergence and F08 provenance remain subject to the host boundaries above.

## ESLint conventions

- **No explicit `any`** (error)
- **No unused vars** (ignore `_` prefix)
- **Explicit function return types** (warn, allow expressions)
- **Consistent type assertions** (error)
- **prefer-const** (error)

## Test fixtures

Tests generally mock `fetch` globally via `vi.stubGlobal("fetch", vi.fn())`. `src/plugin.lifecycle.test.ts`, `src/plugin.source.test.ts`, and `src/plugin.composition.test.ts` exercise transform replay and precedence; `src/plugin.encoder.test.ts` checks installed V2 request encoding. `scripts/debug-provider.test.ts` tests debug helpers; `scripts/node-fallback.test.ts` runs direct-Node subprocess checks of offline catalog fallback and the debug entrypoint.
