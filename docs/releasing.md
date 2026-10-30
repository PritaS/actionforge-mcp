# Release gate

Use Node 22.18+ and a clean checkout. Install development dependencies with `npm install`, then run `npm run check:package`. It builds, runs protocol tests, packs without publishing, checks compiled modules and bin, unpacks to a temporary directory and exercises the real packed server with the existing stdio smoke. Requires npm and tar on PATH.

The smoke checks initialization, silent notifications and a transport error against an unreachable local API. It does not certify successful tool invocation or compatibility with named desktop clients. Record client versions and staging invocation results before making those claims.

Before a separately authorized publish: inspect `npm pack --dry-run`, synchronize `package.json`/`server.json` versions and review the changelog. This script never publishes, tags, deploys or merges.
