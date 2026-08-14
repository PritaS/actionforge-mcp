/**
 * MCP protocol handling for the ActionForge server — pure and transport-free.
 *
 * Implemented directly against the Model Context Protocol schema rather than
 * via the SDK, for the same reason `lib/billing.ts` speaks Stripe's REST API by
 * hand: it keeps the dependency footprint and CI unchanged, and every branch
 * stays exercisable offline. The message shapes below follow the 2025-06-18
 * schema.
 *
 * The mapping is close to one-to-one, which is why this wrapper is thin: an
 * ActionForge tool already *is* an MCP tool — a name, a description, a JSON
 * Schema for input, and one for output.
 */

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "actionforge";
export const SERVER_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* JSON-RPC 2.0                                                        */
/* ------------------------------------------------------------------ */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Absent on notifications, which take no response. */
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Standard JSON-RPC error codes, plus MCP's server-defined range. */
export const ERROR_PARSE = -32700;
export const ERROR_INVALID_REQUEST = -32600;
export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

/* ------------------------------------------------------------------ */
/* The tool source this server publishes                               */
/* ------------------------------------------------------------------ */

/** An ActionForge tool, reduced to what MCP needs. */
export interface PublishedTool {
  /** MCP tool name — stable, unique within the server. */
  name: string;
  toolId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/**
 * The outcome of invoking a tool.
 *
 * `isError` distinguishes "the tool ran and rejected your input" from "the tool
 * could not be found" — the spec is explicit that the former belongs in the
 * result so the model can see it and self-correct, while only exceptional
 * conditions become protocol errors.
 */
export interface InvokeOutcome {
  ok: boolean;
  /** Structured result on success. */
  result?: Record<string, unknown>;
  /** Human-readable explanation on failure, shown to the model. */
  message?: string;
  /** True when the tool genuinely does not exist — a protocol error. */
  notFound?: boolean;
}

export interface ToolSource {
  listTools(): Promise<PublishedTool[]>;
  invoke(tool: PublishedTool, args: Record<string, unknown>): Promise<InvokeOutcome>;
}

/**
 * Makes an ActionForge tool name usable as an MCP tool name.
 *
 * ActionForge allows spaces (`^[A-Za-z0-9_\- ]+$`); MCP names are identifiers
 * that clients surface directly, so spaces become underscores. Collisions after
 * sanitising are disambiguated with a short suffix from the tool id rather than
 * silently shadowing one another.
 */
export function toMcpToolName(
  rawName: string,
  toolId: string,
  taken: Set<string>
): string {
  const base = rawName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  if (!taken.has(base)) return base;
  return `${base}_${toolId.slice(0, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

/**
 * Handles one JSON-RPC message.
 *
 * Returns null for notifications, which by JSON-RPC take no response — sending
 * one for `notifications/initialized` is a common way to break clients.
 */
export async function handleMessage(
  message: unknown,
  source: ToolSource
): Promise<JsonRpcResponse | null> {
  if (
    !message ||
    typeof message !== "object" ||
    (message as JsonRpcRequest).jsonrpc !== "2.0" ||
    typeof (message as JsonRpcRequest).method !== "string"
  ) {
    return fail(null, ERROR_INVALID_REQUEST, "Not a valid JSON-RPC 2.0 request");
  }

  const req = message as JsonRpcRequest;
  const isNotification = req.id === undefined;
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      // Echo the client's protocol version when we can speak it, so a client
      // pinned to an older revision is not forced to disconnect.
      const requested = (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion:
          typeof requested === "string" && requested.length > 0
            ? requested
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Tools are generated and hosted by ActionForge. Each has a strict JSON " +
          "Schema for its input and output; arguments that do not match the input " +
          "schema are rejected with an explanation you can use to correct the call.",
      });
    }

    // Notifications: acknowledged by returning nothing at all.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : ok(id, {});

    case "tools/list": {
      let tools: PublishedTool[];
      try {
        tools = await source.listTools();
      } catch (err) {
        return fail(id, ERROR_INTERNAL, describe(err));
      }
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: normalizeSchema(t.inputSchema),
          outputSchema: normalizeSchema(t.outputSchema),
        })),
      });
    }

    case "tools/call": {
      const name = req.params?.name;
      if (typeof name !== "string") {
        return fail(id, ERROR_INVALID_PARAMS, "params.name must be a string");
      }
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};

      let tools: PublishedTool[];
      try {
        tools = await source.listTools();
      } catch (err) {
        return fail(id, ERROR_INTERNAL, describe(err));
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        // Failing to *find* a tool is exceptional — a protocol error, per spec.
        return fail(id, ERROR_INVALID_PARAMS, `No such tool: ${name}`);
      }

      let outcome: InvokeOutcome;
      try {
        outcome = await source.invoke(tool, args);
      } catch (err) {
        return fail(id, ERROR_INTERNAL, describe(err));
      }

      if (outcome.notFound) {
        return fail(id, ERROR_INVALID_PARAMS, outcome.message ?? `No such tool: ${name}`);
      }

      if (!outcome.ok) {
        // The tool ran and refused, or is not ready. Reported inside the result
        // with isError so the model can see it and adjust, rather than as a
        // protocol error it cannot introspect.
        return ok(id, {
          content: [{ type: "text", text: outcome.message ?? "Tool invocation failed" }],
          isError: true,
        });
      }

      const result = outcome.result ?? {};
      return ok(id, {
        // Both forms: text for clients that only render content, and
        // structuredContent for those that consume the output schema.
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }

    default:
      if (isNotification) return null;
      return fail(id, ERROR_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}

/**
 * MCP requires a tool's schemas to be objects with `type: "object"`. A tool
 * declared with some other top-level type would otherwise produce a schema a
 * strict client rejects, so it is wrapped the same way the invoke route wraps a
 * non-object result under `value`.
 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && schema.type === "object") return schema;
  return {
    type: "object",
    properties: { value: schema ?? {} },
    required: ["value"],
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
