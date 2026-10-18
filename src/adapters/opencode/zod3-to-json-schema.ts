/**
 * Zod 3 shape -> JSON Schema conversion for the OpenCode V2 plugin host.
 *
 * OpenCode V2's plugin API declares tool inputs as JSON Schema (or Effect
 * Schema / Standard Schema), not zod. The MCP-era tool definitions in
 * src/server.ts carry Zod 3 object schemas; the V2 adapter describes them to
 * the host as JSON Schema so the model sees accurate parameter shapes.
 *
 * Scope note: this converts only what context-mode's tool schemas use (the
 * same inventory zod3tov4.ts handles, see that file for the type list). The
 * V2 adapter re-parses args inside the tool execute() with the original zod
 * schema before invoking the handler, so this conversion only needs to be
 * descriptive, never authoritative.
 */

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject;
  enum?: unknown[];
  anyOf?: JsonSchemaObject[];
  const?: unknown;
  description?: string;
  default?: unknown;
}

interface Zod3Def {
  typeName?: string;
  // structural fields used by the converter — zod v3 internals are untyped
  [key: string]: unknown;
}

function defOf(schema: unknown): Zod3Def | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const def = (schema as { _def?: unknown })._def;
  return def && typeof def === "object" ? (def as Zod3Def) : undefined;
}

/**
 * Unwrap Optional/Default/Nullable/Effects wrappers, reporting whether the
 * field is optional and what default (if any) it carries.
 */
function unwrap(schema: unknown): { base: unknown; optional: boolean; defaultValue?: unknown } {
  let cur: unknown = schema;
  let optional = false;
  let defaultValue: unknown;
  let depth = 0;
  while (depth++ < 20) {
    const def = defOf(cur);
    if (!def) break;
    switch (def.typeName) {
      case "ZodOptional":
        optional = true;
        cur = def.innerType ?? def.type;
        continue;
      case "ZodDefault": {
        optional = true;
        const dv = def.defaultValue;
        defaultValue = typeof dv === "function" ? (dv as () => unknown)() : dv;
        cur = def.innerType ?? def.type;
        continue;
      }
      case "ZodNullable":
        cur = def.innerType ?? def.type;
        continue;
      case "ZodEffects":
        cur = def.schema ?? def.innerType ?? def.type;
        continue;
      default:
        break;
    }
    break;
  }
  return { base: cur, optional, defaultValue };
}

/** Convert a single zod v3 value schema to a JSON Schema fragment. */
export function zod3ValueToJsonSchema(schema: unknown, depth = 0): JsonSchemaObject {
  if (depth > 12) return {};
  const def = defOf(schema);
  if (!def) return {};
  switch (def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodAny":
    case "ZodUnknown":
      return {};
    case "ZodNull":
      return { type: "null" };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodEnum": {
      const values = def.values;
      return Array.isArray(values) && values.length > 0
        ? { type: "string", enum: values }
        : {};
    }
    case "ZodArray":
      return { type: "array", items: zod3ValueToJsonSchema(def.type ?? def.elementType, depth + 1) };
    case "ZodTuple":
      return { type: "array" };
    case "ZodRecord":
      return { type: "object", additionalProperties: zod3ValueToJsonSchema(def.valueType, depth + 1) };
    case "ZodObject": {
      const raw = def.shape;
      const shape = typeof raw === "function" ? (raw as () => Record<string, unknown>)() : raw;
      return zod3ShapeToJsonSchema((shape as Record<string, unknown>) ?? {}, depth + 1);
    }
    case "ZodUnion": {
      const options = def.options;
      if (!Array.isArray(options) || options.length === 0) return {};
      if (options.length === 1) return zod3ValueToJsonSchema(options[0], depth + 1);
      return { anyOf: options.map((option) => zod3ValueToJsonSchema(option, depth + 1)) };
    }
    case "ZodEffects":
      // preprocess/transform: describe the inner (parsed) type. Coercions
      // still run inside the tool execute()'s own zod parse.
      return zod3ValueToJsonSchema(def.schema ?? def.innerType ?? def.type, depth + 1);
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return zod3ValueToJsonSchema(def.innerType ?? def.type, depth + 1);
    default:
      return {};
  }
}

/** Convert a single named field: unwrap wrappers, carry description/default. */
export function zod3FieldToJsonSchema(schema: unknown): JsonSchemaObject {
  const { base, defaultValue } = unwrap(schema);
  const out = zod3ValueToJsonSchema(base, 0);
  const def = defOf(base);
  const own = defOf(schema);
  const description = def?.description ?? own?.description;
  if (typeof description === "string" && description) out.description = description;
  if (defaultValue !== undefined && out.default === undefined) out.default = defaultValue;
  return out;
}

/**
 * Convert a zod v3 object shape (the `{ field: z.schema }` map used by
 * context-mode's tool definitions) into an object JSON Schema.
 */
export function zod3ShapeToJsonSchema(
  shape: Record<string, unknown>,
  depth = 0,
): JsonSchemaObject {
  if (depth > 12) return {};
  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape ?? {})) {
    properties[key] = zod3FieldToJsonSchema(value);
    if (!unwrap(value).optional) required.push(key);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Build the JSON Schema for a full zod v3 object schema (e.g. a tool's
 * `inputSchema`), reading its `.shape()`.
 */
export function zod3ObjectSchemaToJsonSchema(schema: unknown): JsonSchemaObject {
  const def = defOf(schema);
  const raw = def?.shape;
  const shape = typeof raw === "function" ? (raw as () => Record<string, unknown>)() : raw;
  return zod3ShapeToJsonSchema((shape as Record<string, unknown>) ?? {});
}
