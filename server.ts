#!/usr/bin/env node
/**
 * ActionForge MCP server (stdio transport).
 * Run: npx actionforge-mcp   (published)
 *      npx tsx mcp/server.ts   (from a checkout)
 *
 * Publishes an ActionForge account's tools to any MCP client — Claude Desktop,
 * Claude Code, or anything else speaking the protocol. Configuration comes from
 * the environment:
 *
 *   ACTIONFORGE_URL      base URL of the deployment (default http://localhost:3000)
 *   ACTIONFORGE_API_KEY  the account's key; everything published is scoped to it
 *
 * stdout carries protocol frames only — anything else corrupts the stream — so
 * all logging goes to stderr.
 */
import { createInterface } from "node:readline";
import { ActionForgeToolSource } from "./client.js";
import { handleMessage, type JsonRpcResponse } from "./protocol.js";

function log(message: string): void {
  process.stderr.write(`[actionforge-mcp] ${message}\n`);
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function main(): Promise<void> {
  const baseUrl = process.env.ACTIONFORGE_URL ?? "http://localhost:3000";
  const apiKey = process.env.ACTIONFORGE_API_KEY ?? "";

  if (!apiKey) {
    log("ACTIONFORGE_API_KEY is not set — issue one with `npm run keygen`.");
    process.exit(1);
  }

  const source = new ActionForgeToolSource({ baseUrl, apiKey });
  log(`serving tools from ${baseUrl}`);

  // Newline-delimited JSON, one message per line.
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }

    try {
      const response = await handleMessage(parsed, source);
      // null means it was a notification: JSON-RPC forbids replying.
      if (response) send(response);
    } catch (err) {
      // A handler crash must not kill the session — report and keep serving.
      const detail = err instanceof Error ? err.message : String(err);
      log(`handler error: ${detail}`);
      const id =
        parsed && typeof parsed === "object"
          ? ((parsed as { id?: string | number | null }).id ?? null)
          : null;
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${detail}` },
      });
    }
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
