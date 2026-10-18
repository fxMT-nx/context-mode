import "../setup-home";
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  zod3ShapeToJsonSchema,
  zod3ObjectSchemaToJsonSchema,
} from "../../src/adapters/opencode/zod3-to-json-schema.js";
import { computeUsageDelta, ZERO_USAGE } from "../../src/adapters/opencode/v2.js";
import contextModePlugin from "../../src/adapters/opencode/plugin.js";
import contextModeV2Plugin from "../../src/adapters/opencode/v2.js";

// ── zod 3 -> JSON Schema ───────────────────────────────────────────────

describe("zod3ShapeToJsonSchema", () => {
  it("converts a flat shape with required fields and descriptions", () => {
    const shape = {
      name: z.string().describe("User name"),
      age: z.number(),
      active: z.boolean(),
    };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result).toEqual({
      type: "object",
      properties: {
        name: { type: "string", description: "User name" },
        age: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["name", "age", "active"],
      additionalProperties: false,
    });
  });

  it("omits optional fields from required", () => {
    const shape = { path: z.string(), note: z.string().optional() };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result.required).toEqual(["path"]);
    expect(result.properties?.note).toEqual({ type: "string" });
  });

  it("carries default values and treats them as optional", () => {
    const shape = { limit: z.number().default(3) };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result.required).toEqual([]);
    expect(result.properties?.limit).toEqual({ type: "number", default: 3 });
  });

  it("converts enums", () => {
    const shape = { language: z.enum(["javascript", "python", "shell"]) };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result.properties?.language).toEqual({
      type: "string",
      enum: ["javascript", "python", "shell"],
    });
  });

  it("converts arrays with item schemas", () => {
    const shape = { queries: z.array(z.string()) };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result.properties?.queries).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("converts nested objects", () => {
    const shape = {
      requests: z.array(z.object({ url: z.string(), source: z.string().optional() })),
    };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result.properties?.requests).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          source: { type: "string" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    });
  });

  it("unwraps z.preprocess (ZodEffects) to the parsed type", () => {
    // Mirrors ctx_search.queries: z.preprocess(coerceJsonArray, z.array(z.string()))
    const shape = { queries: z.preprocess((value) => value, z.array(z.string())) };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result.properties?.queries).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(result.required).toEqual(["queries"]);
  });

  it("falls back to an empty schema for unsupported types", () => {
    const shape = { when: z.date() };
    const result = zod3ShapeToJsonSchema(shape);
    expect(result.properties?.when).toEqual({});
    expect(result.required).toEqual(["when"]);
  });

  it("converts a full object schema through zod3ObjectSchemaToJsonSchema", () => {
    const schema = z.object({
      commands: z.array(z.object({ label: z.string(), command: z.string() })),
      queries: z.array(z.string()),
      concurrency: z.number().default(1),
    });
    const result = zod3ObjectSchemaToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result.required).toEqual(["commands", "queries"]);
    expect(result.properties?.concurrency).toEqual({ type: "number", default: 1 });
    expect(result.properties?.commands?.items?.required).toEqual(["label", "command"]);
  });

  it("mirrors a real tool schema shape (ctx_execute)", () => {
    const schema = z.object({
      language: z.enum(["javascript", "typescript", "python", "shell"]).describe("Runtime language"),
      code: z.string().describe("Source code to execute."),
      timeout: z.number().optional().describe("Max execution time in ms."),
      background: z.boolean().default(false).describe("Keep process running after timeout."),
      cwd: z.string().optional(),
      intent: z.string().optional(),
    });
    const result = zod3ObjectSchemaToJsonSchema(schema);
    expect(result.required).toEqual(["language", "code"]);
    expect(result.properties?.language?.enum).toContain("javascript");
    expect(result.properties?.background).toEqual({
      type: "boolean",
      default: false,
      description: "Keep process running after timeout.",
    });
  });
});

// ── usage delta math ───────────────────────────────────────────────────

describe("computeUsageDelta", () => {
  it("treats a missing baseline as zero", () => {
    const total = { cost: 0.5, input: 100, output: 10, cacheRead: 50, cacheWrite: 0 };
    expect(computeUsageDelta(undefined, total)).toEqual(total);
  });

  it("emits only the increment between cumulative snapshots", () => {
    const prev = { cost: 0.5, input: 100, output: 10, cacheRead: 50, cacheWrite: 0 };
    const total = { cost: 0.62, input: 130, output: 14, cacheRead: 70, cacheWrite: 2 };
    expect(computeUsageDelta(prev, total)).toEqual({
      cost: expect.closeTo(0.12, 10),
      input: 30,
      output: 4,
      cacheRead: 20,
      cacheWrite: 2,
    });
  });

  it("returns zero deltas for unchanged totals", () => {
    const totals = { cost: 1, input: 10, output: 2, cacheRead: 3, cacheWrite: 4 };
    expect(computeUsageDelta(totals, { ...totals })).toEqual(ZERO_USAGE);
  });

  it("clamps regressions (session reset) to zero", () => {
    const prev = { cost: 2, input: 200, output: 20, cacheRead: 100, cacheWrite: 10 };
    const total = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(computeUsageDelta(prev, total)).toEqual(ZERO_USAGE);
  });
});

// ── export shapes ──────────────────────────────────────────────────────

describe("context-mode plugin exports", () => {
  it("keeps the V1 PluginModule shape (KiloCode / OpenCode 1.x)", () => {
    expect(contextModePlugin.id).toBe("context-mode");
    expect(typeof contextModePlugin.server).toBe("function");
  });

  it("exposes a V2 setup function on the same default export", () => {
    // OpenCode V2 requires `{ id, setup }` and ignores extra keys (V1 `server`).
    expect(contextModePlugin.id).toBe("context-mode");
    expect(typeof contextModePlugin.setup).toBe("function");
  });

  it("exports the V2 entry with a callable setup", () => {
    expect(contextModeV2Plugin.id).toBe("context-mode");
    expect(typeof contextModeV2Plugin.setup).toBe("function");
  });
});
