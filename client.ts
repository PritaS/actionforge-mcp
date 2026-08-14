/**
 * ActionForge-backed tool source for the MCP server.
 *
 * Talks to a deployed ActionForge over HTTP with a Bearer API key, so the MCP
 * server is a thin client rather than a second copy of the platform. Tool
 * discovery reads `GET /api/tools`; invocation posts to each tool's proxy URL.
 */
import {
  toMcpToolName,
  type InvokeOutcome,
  type PublishedTool,
  type ToolSource,
} from "./protocol.js";

interface ApiTool {
  toolId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  proxyUrl: string;
}

const LIST_TIMEOUT_MS = 15_000;
const INVOKE_TIMEOUT_MS = 60_000;

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Tool list is cached this long; 0 disables caching. */
  cacheMs?: number;
}

export class ActionForgeToolSource implements ToolSource {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly cacheMs: number;
  private cache: { at: number; tools: PublishedTool[] } | null = null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.cacheMs = opts.cacheMs ?? 30_000;
  }

  async listTools(): Promise<PublishedTool[]> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) {
      return this.cache.tools;
    }

    const res = await fetch(`${this.baseUrl}/api/tools`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `ActionForge tool listing failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`
      );
    }
    const body = (await res.json()) as { tools?: ApiTool[] };

    const taken = new Set<string>();
    const tools: PublishedTool[] = (body.tools ?? []).map((t) => {
      const name = toMcpToolName(t.toolName, t.toolId, taken);
      taken.add(name);
      return {
        name,
        toolId: t.toolId,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      };
    });

    this.cache = { at: Date.now(), tools };
    return tools;
  }

  /**
   * Invokes a tool and translates ActionForge's status codes into an outcome.
   *
   * The distinction that matters: a 400 means the model sent arguments the tool
   * rejected, which it can fix on the next attempt — so it comes back as a
   * visible error with the validation detail, not a protocol failure. A 404
   * means the tool is gone, which the model cannot fix, so it becomes a
   * protocol error and the client should re-list.
   */
  async invoke(
    tool: PublishedTool,
    args: Record<string, unknown>
  ): Promise<InvokeOutcome> {
    const res = await fetch(`${this.baseUrl}/api/invoke/${tool.toolId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
    });

    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON body — handled by status below */
    }

    if (res.status === 200) {
      const result = body.result;
      return {
        ok: true,
        result:
          result && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : { value: result },
      };
    }

    // The tool is gone. Invalidate the cache so a re-list reflects reality.
    if (res.status === 404) {
      this.cache = null;
      return { ok: false, notFound: true, message: `Tool "${tool.name}" no longer exists` };
    }

    return { ok: false, message: describeFailure(res.status, body, text) };
  }
}

/** Turns an ActionForge error response into guidance the model can act on. */
function describeFailure(
  status: number,
  body: Record<string, unknown>,
  raw: string
): string {
  const error = typeof body.error === "string" ? body.error : `HTTP ${status}`;
  const details =
    body.details === undefined ? "" : ` ${JSON.stringify(body.details)}`;

  switch (status) {
    case 400:
      return `Your arguments did not match the tool's input schema. ${error}.${details} Correct the arguments and try again.`;
    case 402:
      return `${error}.${details} This account is at its plan's tool limit; it is not a problem with your arguments.`;
    case 429:
      return `${error}.${details} Rate limited — wait ${body.retryAfter ?? "a while"} seconds before retrying.`;
    case 503:
      return `${error}.${details} The tool is not ready yet (its edge route is still propagating). Retry shortly.`;
    case 502:
      return `${error}.${details} The tool ran but failed or returned a result violating its own output schema. This is a fault in the tool, not in your arguments.`;
    default:
      return `${error}.${details || ` ${raw.slice(0, 200)}`}`;
  }
}
