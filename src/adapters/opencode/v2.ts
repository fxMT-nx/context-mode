/**
 * OpenCode V2 plugin entry for context-mode.
 *
 * OpenCode 2.x replaced its plugin API: the V1 plugin object returned by
 * createContextModePlugin() (hooks: `tool`, `tool.execute.before`,
 * `tool.execute.after`, `chat.message`, `experimental.session.compacting`,
 * `experimental.chat.system.transform`) is no longer loadable — the host now
 * requires `{ id, setup }` and exposes domains (`ctx.tool.transform`,
 * `ctx.tool.hook`, `ctx.session.hook`, `ctx.event.subscribe`).
 *
 * This adapter translates between the two APIs. All session, routing and
 * snapshot logic stays in the V1 hooks object (single source of truth for the
 * whole OpenCode/KiloCode family); this file only re-wires the host surface:
 *
 *   V1 (createContextModePlugin output)      V2 (this adapter)
 *   ---------------------------------------  ---------------------------------
 *   `tool` (11 ctx_* defs, zod v4 shapes)    ctx.tool.transform + JSON Schema
 *   `tool.execute.before` (throw = deny)     ctx.tool.hook("execute.before")
 *   `tool.execute.after`                     ctx.tool.hook("execute.after")
 *   `chat.message` (user prompts)            ctx.session.hook("prompt")
 *   `experimental.chat.system.transform`     ctx.session.hook("context")
 *   `experimental.session.compacting`        ctx.session.hook("compaction")
 *   generic `event` (message.updated)        ctx.event.subscribe -> mapped V2
 *                                            `session.usage.updated` deltas
 *
 * V2-specific notes:
 *   - The event stream is server-wide while plugin instances load per
 *     location; `sessionOwner` (fed by the location-scoped hooks) attributes
 *     events to the right instance, and `usageTotals` turns V2's CUMULATIVE
 *     `session.usage.updated` totals into deltas for the V1 usage handler.
 *     Both maps live on globalThis so plugin reloads do not re-emit
 *     cumulative totals as fresh spend.
 *   - Routing gates its curl/wget redirects behind a live
 *     `context-mode-mcp-ready-<pid>` sentinel. This adapter provides the
 *     tools natively, so it publishes the sentinel for its own process and
 *     refreshes it - no stdio MCP child needed.
 *   - Routing messages name tools via the "opencode" convention
 *     (context-mode_ctx_*), which matches the MCP-era naming. The native
 *     tools are bare ctx_*; rewritten shell commands get the prefix stripped.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ContextModePlugin } from "./plugin.js";
import { zod3ObjectSchemaToJsonSchema } from "./zod3-to-json-schema.js";

type V1Factory = typeof ContextModePlugin;
type V1Hooks = Awaited<ReturnType<V1Factory>>;
type V1FactoryContext = Parameters<V1Factory>[0];

// ── Minimal structural types for the V2 host surface ───────────────────
// The OpenCode V2 plugin SDK is not a dependency of this package; these
// shapes mirror @opencode/plugin@2.x (Context, ToolEditor, hook events).

interface V2SystemPart {
  type?: string;
  text?: string;
}

interface V2ToolExecuteBeforeEvent {
  tool: string;
  sessionID?: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface V2ToolExecuteAfterEvent extends V2ToolExecuteBeforeEvent {
  status?: string;
  result?: unknown;
  error?: unknown;
}

interface V2PluginContext {
  location?: { directory?: string };
  tool: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<unknown>;
    hook(
      name: "execute.before" | "execute.after",
      callback: (event: any) => Promise<void> | void,
    ): Promise<unknown>;
  };
  session: {
    hook(
      name: "prompt" | "context" | "compaction",
      callback: (event: any) => Promise<void> | void,
    ): Promise<unknown>;
  };
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<any>;
  };
}

interface V2ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: unknown;
    execute: (input: any, context: any) => Promise<{ content?: string }>;
  }): void;
}

// ── Usage delta math (pure, unit-tested) ───────────────────────────────

export interface UsageTotals {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: UsageTotals = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * OpenCode V2 publishes `session.usage.updated` with CUMULATIVE per-session
 * totals (cost + token buckets). context-mode's usage chain expects
 * per-occurrence amounts, so emit the increment since the previous snapshot.
 * Missing baselines count as zero; negative regressions (session fork /
 * reset) clamp to zero.
 */
export function computeUsageDelta(prev: UsageTotals | undefined, total: UsageTotals): UsageTotals {
  const base = prev ?? ZERO_USAGE;
  return {
    cost: Math.max(0, total.cost - base.cost),
    input: Math.max(0, total.input - base.input),
    output: Math.max(0, total.output - base.output),
    cacheRead: Math.max(0, total.cacheRead - base.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - base.cacheWrite),
  };
}

function hasUsage(totals: UsageTotals): boolean {
  return (
    totals.cost > 0 ||
    totals.input > 0 ||
    totals.output > 0 ||
    totals.cacheRead > 0 ||
    totals.cacheWrite > 0
  );
}

function sameDir(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  );
}

// ── V2 setup ───────────────────────────────────────────────────────────

export async function createContextModeV2Setup(ctx: V2PluginContext): Promise<() => void> {
  const projectDir = ctx.location?.directory || process.cwd();
  const debug = (message: string): void => {
    if (process.env.OPENCODE_DEBUG) console.error(`[context-mode] ${message}`);
  };

  // Process-global state shared across plugin instances (one per location)
  // and across plugin reloads within the same server process.
  const usageTotals = (globalThis as any)[Symbol.for("context-mode.v2.usageTotals")] as
    | Map<string, UsageTotals>
    | undefined;
  const usageTotalsMap: Map<string, UsageTotals> =
    usageTotals ?? new Map<string, UsageTotals>();
  (globalThis as any)[Symbol.for("context-mode.v2.usageTotals")] = usageTotalsMap;
  const sessionOwnerMap: Map<string, string> =
    ((globalThis as any)[Symbol.for("context-mode.v2.sessionOwner")] as Map<string, string>) ??
    new Map<string, string>();
  (globalThis as any)[Symbol.for("context-mode.v2.sessionOwner")] = sessionOwnerMap;

  // 1. Load the V1 hooks object - the engine for every OpenCode-family host.
  const clientStub = {
    app: { log: async () => undefined },
  } as unknown as V1FactoryContext["client"];
  const v1: V1Hooks = await ContextModePlugin({ client: clientStub, directory: projectDir });

  // 2. Original zod v3 input schemas for the JSON Schema conversion. The V1
  //    factory already imported server.js (buildNativeTools); this re-import
  //    hits the module cache. Env flag mirrors src/server.ts's embedded-host
  //    detection so importing the server registers handlers without starting
  //    a stdio transport.
  const prevEmbedded = process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
  process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
  let serverMod: typeof import("../../server.js");
  try {
    serverMod = await import("../../server.js");
  } finally {
    if (prevEmbedded === undefined) delete process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
    else process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = prevEmbedded;
  }
  const inputSchemas = new Map<string, unknown>(
    serverMod.REGISTERED_CTX_TOOLS.map((entry) => [
      entry.name,
      (entry.config as { inputSchema?: unknown }).inputSchema,
    ]),
  );

  // 3. Native ctx_* tools: V1 `tool` defs -> ctx.tool.transform.
  await ctx.tool.transform((editor) => {
    for (const [name, def] of Object.entries(v1.tool)) {
      editor.add({
        name,
        description: String(def.description ?? ""),
        input: zod3ObjectSchemaToJsonSchema(inputSchemas.get(name)),
        execute: async (args: unknown, toolCtx: any) => {
          // The V1 def re-parses args with the original zod schema (defaults,
          // coercions, validation) before invoking the handler.
          const v1Def = def as unknown as {
            execute: (a: unknown, c: unknown) => Promise<{ output?: unknown }>;
          };
          const result = await v1Def.execute(args, {
            sessionID: toolCtx?.sessionID,
            directory: projectDir,
            metadata: (update: unknown) => {
              void toolCtx?.progress?.(update)?.catch?.(() => {});
            },
          });
          return { content: String(result?.output ?? "") };
        },
      });
    }
  });
  debug(`registered ${Object.keys(v1.tool).length} native ctx_* tools for ${projectDir}`);

  // 4. Routing enforcement: V1 tool.execute.before (throw = deny).
  await ctx.tool.hook("execute.before", async (event: V2ToolExecuteBeforeEvent) => {
    if (event.sessionID) sessionOwnerMap.set(event.sessionID, projectDir);
    const input = event.input ?? {};
    try {
      await v1["tool.execute.before"](
        { tool: event.tool, sessionID: event.sessionID ?? "", callID: event.id ?? "" },
        { args: input },
      );
    } catch (error) {
      debug(`denied ${event.tool}: ${String((error as Error)?.message ?? error)}`);
      throw error;
    }
    // Routing may rewrite the shell command with redirect guidance that names
    // MCP-era tools (context-mode_ctx_*). The native tools are bare ctx_*.
    if (typeof input.command === "string" && input.command.includes("context-mode_ctx_")) {
      input.command = input.command.replaceAll("context-mode_ctx_", "ctx_");
    }
    event.input = input;
  });

  // 5. Session capture: V1 tool.execute.after.
  await ctx.tool.hook("execute.after", async (event: V2ToolExecuteAfterEvent) => {
    if (event.sessionID) sessionOwnerMap.set(event.sessionID, projectDir);
    try {
      const output = event.status === "completed" ? event.result : { error: event.error };
      await v1["tool.execute.after"](
        {
          tool: event.tool,
          sessionID: event.sessionID ?? "",
          callID: event.id ?? "",
          args: event.input,
        },
        // The V1 hook feeds `output.output` into extractEvents, which accepts
        // strings and structured results alike; the declared string type is
        // V1's shape, the runtime contract is wider.
        { title: "", output: output as unknown as string, metadata: undefined },
      );
    } catch {
      // capture must never break the tool call (V1 hook is also fail-soft)
    }
  });

  // 6. User-prompt capture: V1 chat.message.
  await ctx.session.hook("prompt", async (event: any) => {
    if (event?.sessionID) sessionOwnerMap.set(event.sessionID, projectDir);
    const text = event?.prompt?.text;
    if (typeof text !== "string" || !text) return;
    try {
      await v1["chat.message"](
        { sessionID: event.sessionID },
        { message: undefined, parts: [{ type: "text", text }] },
      );
    } catch {
      // prompt capture must never break admission
    }
  });

  // 7. System transform: V1 experimental.chat.system.transform (routing block
  //    + resume snapshot injection). V1 mutates a string[] via splice; V2's
  //    system is Array<SystemPart>, so wrap and write back in order.
  await ctx.session.hook("context", async (event: any) => {
    if (event?.sessionID) sessionOwnerMap.set(event.sessionID, projectDir);
    if (!Array.isArray(event?.system)) return;
    try {
      const texts: string[] = event.system.map((part: V2SystemPart) =>
        part && typeof part === "object" && part.type === "text" ? String(part.text ?? "") : "",
      );
      const output = { system: texts };
      await v1["experimental.chat.system.transform"](
        { sessionID: event.sessionID, model: undefined },
        output,
      );
      event.system.length = 0;
      for (const text of output.system) {
        event.system.push({ type: "text", text });
      }
    } catch {
      // never break the chat turn on injection failure
    }
  });

  // 8. Compaction snapshots: V1 experimental.session.compacting. The V1 hook
  //    persists the resume snapshot; the context array it fills is discarded
  //    (V2 compaction has no context-injection channel - the stored snapshot
  //    is claimed by the next session's `context` hook instead).
  await ctx.session.hook("compaction", async (event: any) => {
    if (event?.sessionID) sessionOwnerMap.set(event.sessionID, projectDir);
    try {
      await v1["experimental.session.compacting"](
        { sessionID: event.sessionID ?? "" },
        { context: [] },
      );
    } catch {
      // compaction must never break the session
    }
  });

  // 9. Usage capture: V2 emits `session.usage.updated` (CUMULATIVE totals)
  //    instead of V1's per-message `message.updated`. Track totals per
  //    session and feed deltas into the V1 event handler. The stream is
  //    server-wide; `sessionOwner` routes each event to the owning instance.
  const modelBySession = new Map<string, string>();
  const abort = new AbortController();
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
        try {
          const sessionId = ev?.data?.sessionID;
          if (typeof sessionId === "string") {
            const owner = sessionOwnerMap.get(sessionId);
            if (owner !== undefined && !sameDir(owner, projectDir)) continue;
            if (owner === undefined) sessionOwnerMap.set(sessionId, projectDir);
          }
          if (ev?.location?.directory && !sameDir(ev.location.directory, projectDir)) continue;

          if (ev?.type === "session.model.selected") {
            const model = ev.data?.model;
            if (typeof sessionId === "string" && model && (model.id || model.providerID)) {
              modelBySession.set(sessionId, `${model.providerID ?? ""}/${model.id ?? ""}`);
            }
            continue;
          }
          if (ev?.type !== "session.usage.updated") continue;

          const data = ev.data;
          if (!data || typeof data.sessionID !== "string") continue;
          const num = (value: unknown): number =>
            typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
          const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : {};
          const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
          const total: UsageTotals = {
            cost: typeof data.cost === "number" && Number.isFinite(data.cost) ? data.cost : 0,
            input: num(tokens.input),
            output: num(tokens.output),
            cacheRead: num(cache.read),
            cacheWrite: num(cache.write),
          };
          const delta = computeUsageDelta(usageTotalsMap.get(data.sessionID), total);
          // Only advance the baseline on real totals - a degenerate all-zero
          // event must not wipe a good baseline.
          if (hasUsage(total)) usageTotalsMap.set(data.sessionID, total);
          if (!hasUsage(delta)) continue;

          await v1.event({
            event: {
              type: "message.updated",
              properties: {
                info: {
                  role: "assistant",
                  sessionID: data.sessionID,
                  cost: delta.cost,
                  tokens: {
                    input: delta.input,
                    output: delta.output,
                    cache: { read: delta.cacheRead, write: delta.cacheWrite },
                  },
                  model: modelBySession.get(data.sessionID) ?? "",
                },
              },
            },
          });
        } catch {
          // per-event failures must never kill the stream
        }
      }
    } catch {
      // stream closed
    }
  })();

  // 10. Ready sentinel: routing gates its redirects behind a live
  //     `context-mode-mcp-ready-<pid>` sentinel scanned in tmpdir. Native
  //     tools make an MCP child unnecessary, so publish the marker for this
  //     process and keep its mtime fresh (90s freshness window upstream).
  let sentinelTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const buildDir = dirname(fileURLToPath(import.meta.url));
    const sentinelModPath = resolve(buildDir, "..", "..", "..", "hooks", "core", "mcp-ready.mjs");
    const sentinelMod = (await import(pathToFileURL(sentinelModPath).href)) as {
      sentinelPathForPid: (pid: number) => string;
    };
    const sentinelPath = sentinelMod.sentinelPathForPid(process.pid);
    const touch = (): void => {
      try {
        writeFileSync(sentinelPath, String(process.pid));
      } catch {
        // best effort
      }
    };
    touch();
    sentinelTimer = setInterval(touch, 30_000);
    sentinelTimer.unref?.();
  } catch {
    // no sentinel - routing falls back to passthrough; tools still work
  }

  return () => {
    abort.abort();
    if (sentinelTimer) clearInterval(sentinelTimer);
    // The sentinel file is intentionally left behind: a live PID is what
    // isMCPReady() probes first, and stale files are cleaned by its own scan.
  };
}

export default { id: "context-mode", setup: createContextModeV2Setup };
