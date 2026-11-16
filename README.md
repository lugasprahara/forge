# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lugasprahara/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/lugasprahara/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge is a standalone GitHub-compatible git forge in a single Node process: git smart HTTP, REST v3, GraphQL and MCP served over a pure-JS git object store — no git binary, no dependencies.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=aes5np1n&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

An original, dependency-free git forge written in TypeScript for Node 22
(standard library only). One process serves the four surfaces git tooling and
agents already speak, all backed by a single in-memory store:

- **Git smart HTTP** — protocol v0 and v2 ref advertisement, `ls-refs` with
  ref-prefix filtering, fetch with want/have negotiation, shallow clones and
  deepening, and receive-pack with fast-forward checks and `report-status`.
  The git object model (blobs, trees, commits, annotated tags), packfile
  reading/writing and delta application are implemented from scratch in
  `gitcore.ts` — there is no git binary involved.
- **REST v3** (`/api/v3`) — repositories (CRUD + `Link`-header pagination),
  branches and git refs, commit listing, the contents API (file writes build
  real commits on the object store), labels, issues and comments, and pull
  requests with file diffs and a real squash merge (file-level three-way
  merge over the object store).
- **GraphQL v4** (`/api/graphql`) — the queries and mutations `gh` and
  github-mcp-server send: viewer, repository fields, issue/pull-request reads,
  cursor pagination, `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment`, Relay `node(id:)` with opaque global ids,
  `__type` introspection, and operation batching.
- **MCP** (`/mcp`) — JSON-RPC 2.0 over Streamable HTTP in both protocol eras
  (the 2026-07-28 `server/discover` revision and the legacy `initialize`
  handshake), with tools for repositories, issues and pull requests acting on
  the same store as the REST surface.

## Running

The entry follows the agent/v1 lifecycle: it needs `MAKEFUN_ENV_URL` (the
suite's origin) and `MAKEFUN_SHOP_TOKEN` (the bearer token every API call
presents), binds an ephemeral port, registers it, and serves until the suite
says the trial is done.

```
node main.ts
```

State lives in memory for the length of the run. Every timestamp derives from
`MAKEFUN_TRIAL_NOW` plus a per-process sequence, so a replayed trial produces
identical responses.

## Layout

- `main.ts` — the entry ↔ env lifecycle (register, poll `/done`, exit).
- `app.ts` — the HTTP router and auth.
- `gitcore.ts` — SHA-1 object model, packfiles, deltas, pkt-lines.
- `githttp.ts` — smart-HTTP advertisement, upload-pack, receive-pack.
- `forge.ts` — repositories, refs, issues, pull requests, merges, diffs.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — a small GraphQL parser and executor for the suite's documents.
- `mcp.ts` — the MCP endpoint and its tools.
- `webutil.ts` — shared HTTP helpers.

## License

MIT — see `LICENSE`.
