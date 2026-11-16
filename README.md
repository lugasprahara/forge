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
  requests with file diffs and a real squash merge (a file-level three-way
  merge over the object store).
- **GraphQL v4** (`/api/graphql`) — the queries and mutations `gh` and
  github-mcp-server send: viewer, repository fields, issue/pull-request
  reads, cursor pagination, `createIssue` / `closeIssue` /
  `createPullRequest` / `mergePullRequest` / `addComment`, Relay `node(id:)`
  with opaque global ids, `__type` introspection, and operation batching.
- **MCP** (`/mcp`) — JSON-RPC 2.0 over Streamable HTTP, both the 2026-07-28
  `server/discover` revision and the legacy `initialize` handshake, with
  tools to create and read repositories, issues and pull requests over the
  same store the other surfaces use.

## How it is built for speed

The forge's second iteration is tuned on the paths the timed workloads
exercise:

- **Receive-pack** parses a pack in one pass: each entry is inflated exactly
  once (the zlib engine reports the bytes it consumed) and carries its object
  id out of the parse, so storing it never hashes the same bytes twice.
- **Fast-forward checks** stop at the first matching parent instead of
  collecting a branch's whole ancestry, which is what a one-commit push
  (the common case) needs.
- **Tree flattening** — the path-to-blob listing merges and diffs ask for —
  is cached on the object store and shared by every reader.
- **Line diffs** trim the common head and tail before the LCS table runs, so
  appends and small edits never build the table at all.
- **Routing** splits the raw request target directly instead of running the
  WHATWG URL parser per request, keeping the small-GET path cheap.

State is deterministic: every timestamp derives from `MAKEFUN_TRIAL_NOW`
plus a per-process sequence, never from the wall clock, so a replayed trial
produces byte-identical state.
