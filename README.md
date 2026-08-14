# ActionForge MCP server

[![npm](https://img.shields.io/npm/v/actionforge-mcp)](https://www.npmjs.com/package/actionforge-mcp)

Publishes an [ActionForge](https://pritas.github.io/actionforge_ui/) account's
tools to any MCP client — Claude Desktop, Claude Code, or anything else speaking
the Model Context Protocol.

**ActionForge** turns a description and a pair of JSON Schemas into a hosted API
endpoint. You describe the function you need; it generates the implementation,
deploys it as a serverless function, and returns a validated URL. Every tool is
a pure function of its input — generated code is scanned before deploy and
refused if it reaches the network or executes code built at runtime.

This package is the MCP bridge: your endpoints become tools Claude can call
directly. It has **no runtime dependencies** — stdio, `fetch`, and about 500
lines.

Get an API key at
[pritas.github.io/actionforge_ui](https://pritas.github.io/actionforge_ui/#start).

The mapping is close to one-to-one, which is why this wrapper is thin: an
ActionForge tool already *is* an MCP tool — a name, a description, a JSON Schema
for input, and one for output. `tools/list` reads `GET /api/tools`;
`tools/call` posts to the tool's proxy URL.

Implemented directly against the 2025-06-18 protocol schema rather than via the
SDK. That keeps the install to a single package with nothing beneath it, and
every branch stays exercisable offline — `npm run smoke` drives the compiled
server over stdio against a closed port, so the handshake, the silence expected
of a notification, and transport-failure handling are all checked without an
account.

## Install

```bash
npx actionforge-mcp
```

Zero runtime dependencies — the whole server is stdio, `fetch`, and about 500
lines. Nothing to install beyond Node 20.12+.

From a checkout of this repo instead:

```bash
npm install
npm run build
node dist/server.js
```

## Configure

```bash
export ACTIONFORGE_URL=https://your-deployment.example.com
export ACTIONFORGE_API_KEY=af_...        # from POST /api/signup, or npm run keygen
npx actionforge-mcp
```

Everything published is scoped to that key's account. Point it at a different
key and it publishes a different tenant's tools — the API enforces the scoping,
so the MCP server cannot see past it.

Transport is stdio with newline-delimited JSON. **stdout carries protocol
frames only**; all logging goes to stderr, because anything else corrupts the
stream a client is parsing.

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "actionforge": {
      "command": "npx",
      "args": ["-y", "actionforge-mcp"],
      "env": {
        "ACTIONFORGE_URL": "https://your-deployment.example.com",
        "ACTIONFORGE_API_KEY": "af_..."
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add actionforge \
  --env ACTIONFORGE_URL=https://your-deployment.example.com \
  --env ACTIONFORGE_API_KEY=af_... \
  -- npx -y actionforge-mcp
```

## How failures are reported

The protocol draws a line this server follows exactly, because it decides
whether a model can recover on its own:

| Situation | Reported as | Why |
|---|---|---|
| Arguments fail the tool's `input_schema` (400) | result with `isError: true` | The model can read the validation detail and fix the call |
| Tool not ready yet (503) | result with `isError: true` | Transient — retry shortly |
| Rate limited (429) | result with `isError: true` | Includes how long to wait |
| Tool ran but broke its own `output_schema` (502) | result with `isError: true`, named as a fault in the tool | Not the model's arguments |
| Tool does not exist (404), or an unknown tool name | JSON-RPC error | Nothing the model can correct; the client should re-list |
| ActionForge unreachable | JSON-RPC error `-32603` | Transport failure, not a tool result |

Anything the model could act on stays inside the result where it can see it.
Only genuinely exceptional conditions become protocol errors.

## Caching

The tool list is cached for 30 seconds, and the cache is dropped immediately
when a tool turns out to be gone — so a deleted tool disappears on the next
listing rather than lingering until the TTL expires.

## Publishing

```bash
npm run build && npm run smoke
npm publish --access public
```

`dist/` is gitignored — it is a build artifact, rebuilt by `prepublishOnly`, so
what npm receives is always compiled from the committed source.

Bump `version` before each publish; npm refuses to overwrite a released
version.
