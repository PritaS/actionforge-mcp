/**
 * Protocol conformance, run against dist/ — the code npm actually ships.
 *
 * A wrong `initialize` result, or any reply at all to a notification, breaks
 * real clients in ways that are hard to diagnose from the other side. Shapes
 * here are checked against the 2025-06-18 MCP schema.
 *
 * The other half is the error contract. The spec is explicit that a tool that
 * *ran and refused* belongs in the result with `isError: true`, so the model can
 * read it and correct itself, while only failing to *find* a tool is a protocol
 * error. Both are pinned below.
 */
import { PROTOCOL_VERSION, handleMessage, toMcpToolName } from "../dist/protocol.js";

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

/** A ToolSource whose behaviour each test dictates. */
class FakeSource {
  constructor() {
    this.tools = [{
      name: "doubler",
      toolId: "11111111-1111-4111-8111-111111111111",
      description: "Doubles a number.",
      inputSchema: { type: "object", required: ["value"], properties: { value: { type: "number" } } },
      outputSchema: { type: "object", required: ["doubled"], properties: { doubled: { type: "number" } } },
    }];
    this.outcome = { ok: true, result: { doubled: 42 } };
    this.lastArgs = null;
    this.listError = null;
  }
  async listTools() { if (this.listError) throw this.listError; return this.tools; }
  async invoke(_t, args) { this.lastArgs = args; return this.outcome; }
}

const rpc = (method, params, id = 1) => {
  const m = { jsonrpc: "2.0", method };
  if (id !== null) m.id = id;
  if (params) m.params = params;
  return m;
};

const source = new FakeSource();
console.log("── protocol conformance ──────────────────────────────\n");

console.log("[1] initialize handshake");
const init = await handleMessage(rpc("initialize", { protocolVersion: PROTOCOL_VERSION }), source);
check("returns a result", init !== null && init.error === undefined, init?.error);
check("echoes the protocol version", init.result?.protocolVersion === PROTOCOL_VERSION);
check("declares the tools capability", typeof init.result?.capabilities?.tools === "object");
check("serverInfo has name and version",
  typeof init.result?.serverInfo?.name === "string" && typeof init.result?.serverInfo?.version === "string");
// A client pinned to an older revision must not be forced to disconnect.
const older = await handleMessage(rpc("initialize", { protocolVersion: "2025-03-26" }), source);
check("accepts a client on an older protocol version", older?.result?.protocolVersion === "2025-03-26");

console.log("\n[2] Notifications are not answered");
check("notifications/initialized returns nothing",
  (await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, source)) === null);
check("an unknown notification returns nothing",
  (await handleMessage({ jsonrpc: "2.0", method: "notifications/whatever" }, source)) === null);
check("ping with an id is answered", (await handleMessage(rpc("ping"), source))?.result !== undefined);

console.log("\n[3] tools/list publishes the account's tools");
const listed = (await handleMessage(rpc("tools/list"), source))?.result?.tools;
check("returns one tool", listed?.length === 1, listed?.length);
check("has a name", listed?.[0]?.name === "doubler");
check("has a description", typeof listed?.[0]?.description === "string");
check("inputSchema is an object schema", listed?.[0]?.inputSchema?.type === "object");
check("outputSchema is published too", listed?.[0]?.outputSchema?.type === "object");
// A non-object schema must be wrapped, or strict clients reject the tool.
source.tools = [{ ...source.tools[0], inputSchema: { type: "string" } }];
const wrapped = (await handleMessage(rpc("tools/list"), source))?.result?.tools[0]?.inputSchema;
check("a non-object input schema is wrapped as an object", wrapped?.type === "object", wrapped);
source.tools = new FakeSource().tools;

console.log("\n[4] tools/call returns content and structuredContent");
const call = (await handleMessage(rpc("tools/call", { name: "doubler", arguments: { value: 21 } }), source))?.result;
check("arguments are forwarded", source.lastArgs?.value === 21, source.lastArgs);
check("no isError on success", call?.isError === undefined);
check("content is a text block", call?.content?.[0]?.type === "text" && typeof call.content[0]?.text === "string");
check("structuredContent carries the result", call?.structuredContent?.doubled === 42);

console.log("\n[5] Tool failures are results with isError, not protocol errors");
source.outcome = { ok: false, message: "Your arguments did not match the input schema." };
const refused = await handleMessage(rpc("tools/call", { name: "doubler", arguments: {} }), source);
check("it is a result, not an error", refused?.error === undefined && refused?.result !== undefined);
check("isError is set", refused?.result?.isError === true);
check("the explanation reaches the model",
  String(refused?.result?.content?.[0]?.text).includes("input schema"));

console.log("\n[6] A missing tool is a protocol error");
const missing = await handleMessage(rpc("tools/call", { name: "nope", arguments: {} }), source);
check("unknown tool name → error", missing?.error !== undefined, missing?.result);
check("uses invalid-params", missing?.error?.code === -32602, missing?.error?.code);
source.outcome = { ok: false, notFound: true, message: "gone" };
check("a deleted tool → error, not isError",
  (await handleMessage(rpc("tools/call", { name: "doubler", arguments: {} }), source))?.error !== undefined);
source.outcome = { ok: true, result: { doubled: 42 } };

console.log("\n[7] Malformed requests and upstream failures");
check("a non-JSON-RPC message is rejected",
  (await handleMessage({ hello: "world" }, source))?.error?.code === -32600);
check("an unknown method is rejected",
  (await handleMessage(rpc("tools/destroy"), source))?.error?.code === -32601);
check("tools/call without a name is invalid params",
  (await handleMessage(rpc("tools/call", {}), source))?.error?.code === -32602);
source.listError = new Error("ActionForge unreachable");
const upstream = await handleMessage(rpc("tools/list"), source);
check("an upstream failure is an internal error", upstream?.error?.code === -32603);
check("the reason is surfaced", String(upstream?.error?.message).includes("unreachable"));
source.listError = null;

console.log("\n[8] Tool names are mapped to MCP identifiers");
const taken = new Set();
const n1 = toMcpToolName("DSCR Calculator", "aaaaaaaa-1111", taken);
taken.add(n1);
check("spaces become underscores", n1 === "DSCR_Calculator", n1);
const n2 = toMcpToolName("DSCR Calculator", "bbbbbbbb-2222", taken);
check("a collision is disambiguated, not shadowed", n2 !== n1 && n2.startsWith("DSCR_Calculator"), n2);
check("an empty name still yields an identifier", toMcpToolName("   ", "cccccccc-3333", new Set()).length > 0);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
