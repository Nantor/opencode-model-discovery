import { z } from "zod";

// ---------------------------------------------------------------------------
// OpenCode config Zod schema — fetched at runtime from https://opencode.ai/config.json
// ---------------------------------------------------------------------------

const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

/**
 * Recursively remove any "$ref" keys whose value starts with "http" (external refs).
 * z.fromJSONSchema() only supports local refs (#/...).
 *
 * When the external "$ref" is the *only* key in an object, dropping it would
 * produce `{}` which JSON Schema treats as "accept anything" — identical to the
 * behaviour we want, but for the wrong reason (an empty schema is vacuously
 * true rather than explicitly permissive).  We use the boolean schema `true`
 * instead, which is the canonical JSON Schema way to express "any value is
 * valid" and makes the intent explicit.
 */
export function stripExternalRefs(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripExternalRefs);
  }
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const hasOnlyExternalRef =
      Object.keys(record).length === 1 &&
      typeof record["$ref"] === "string" &&
      (record["$ref"] as string).startsWith("http");
    if (hasOnlyExternalRef) {
      // Replace with the boolean `true` schema (accept anything) so that
      // z.fromJSONSchema() doesn't misinterpret an empty object as a fully
      // unconstrained schema that coincidentally passes all inputs.
      return true;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("http")) {
        // drop external $ref that coexists with other keywords (e.g. "type")
        continue;
      }
      result[k] = stripExternalRefs(v);
    }
    return result;
  }
  return obj;
}

/** Module-level cache so we only fetch the schema once per process. */
let _schemaCache: ReturnType<typeof z.fromJSONSchema> | null = null;

/** Reset the schema cache — exposed for use in tests. */
export function resetSchemaCache(): void {
  _schemaCache = null;
}

/**
 * Fetch and compile the OpenCode JSON Schema from the canonical URL.
 * Result is cached after the first call.
 */
async function loadOpenCodeSchema(): Promise<
  ReturnType<typeof z.fromJSONSchema>
> {
  if (_schemaCache) return _schemaCache;
  const response = await fetch(OPENCODE_SCHEMA_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenCode schema from ${OPENCODE_SCHEMA_URL}: ${response.status} ${response.statusText}`,
    );
  }
  const raw = await response.json();
  const cleaned = stripExternalRefs(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _schemaCache = z.fromJSONSchema(cleaned as any);
  return _schemaCache;
}

/**
 * Validate a config object against the OpenCode schema fetched from the canonical URL.
 * Throws an error listing all validation failures if the config is invalid.
 */
export async function validateConfig(config: unknown): Promise<void> {
  const schema = await loadOpenCodeSchema();
  const result = schema.safeParse(config);
  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join(".") || "(root)"}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Generated config does not match the OpenCode schema:\n${errors}`,
    );
  }
}

/**
 * Returns the compiled Zod schema for the OpenCode config.
 * Fetches and caches on first call.
 */
