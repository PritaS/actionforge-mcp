/**
 * Drives the compiled server over stdio the way a client would.
 *
 * Points at a closed port on purpose: the handshake must succeed without any
 * network, the notification must produce no reply, and tools/list must fail as
 * a transport error rather than crashing. Those three are the contract a client
 * depends on, and they are checkable without an ActionForge account.
 */
import { spawn } from "node:child_process";

const child = spawn("node", ["dist/server.js"], {
  env: { ...process.env, ACTIONFORGE_URL: "http://127.0.0.1:9", ACTIONFORGE_API_KEY: "af_smoke" },
  stdio: ["pipe", "pipe", "inherit"],
});

const frames = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];
for (const f of frames) child.stdin.write(JSON.stringify(f) + "\n");
child.stdin.end();

let out = "";
child.stdout.on("data", (d) => (out += d));

const timer = setTimeout(() => {
  console.error("smoke: timed out waiting for responses");
  child.kill();
  process.exit(1);
}, 15000);

child.on("close", () => {
  clearTimeout(timer);
  const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const fail = (m) => { console.error("smoke:", m); process.exit(1); };

  if (lines.length !== 2) fail(`expected 2 responses (the notification must not be answered), got ${lines.length}`);

  const init = lines.find((l) => l.id === 1);
  if (!init?.result) fail("initialize returned no result");
  if (init.result.protocolVersion !== "2025-06-18") fail(`unexpected protocol version ${init.result.protocolVersion}`);
  if (init.result.serverInfo?.name !== "actionforge") fail("serverInfo.name is not actionforge");
  if (!init.result.capabilities?.tools) fail("tools capability not declared");

  const list = lines.find((l) => l.id === 2);
  if (!list?.error) fail("tools/list against an unreachable API should be a JSON-RPC error");
  if (list.error.code !== -32603) fail(`expected -32603 for a transport failure, got ${list.error.code}`);

  console.log("smoke: ok — handshake, silent notification, and transport failure all correct");
});
