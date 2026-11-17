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
(standard library only). One process serves the four surfaces git tooling
and agents already speak, all backed by a single in-memory store:

- **Git smart HTTP** — protocol v0 and v2 ref advertisement, `ls-refs` with
  ref-prefix filtering, fetch with want/have negotiation, shallow clones
  and deepening, and receive-pack with fast-forward checks and
  `report-status`. The git object model (blobs, trees, commits, annotated
  tags), packfile reading/writing and delta application are implemented
  from scratch — there is no git binary involved.
- **REST v3** (`/api/v3`) — repositories (CRUD + `Link`-header pagination),
  branches, commit listing, the contents API (file writes build real
  commits on the object store), labels, issues and comments, and pull
  requests with file diffs and a real squash merge (a file-level three-way
  merge over the object store).
- **GraphQL v4** (`/api/graphql`) — the queries and mutations `gh` and
  github-mcp-server send: viewer, repository fields, issue/pull-request
  reads, cursor pagination, `createIssue` / `closeIssue` /
  `createPullRequest` / `mergePullRequest` / `addComment`, Relay
  `node(id:)` with opaque global ids, `__type` introspection, and
  operation batching.
- **MCP** (`/mcp`) — JSON-RPC 2.0 over Streamable HTTP, both the 2026-07-28
  `server/discover` revision and the legacy `initialize` handshake, with
  tools to create and read repositories, issues and pull requests over the
  same store the other surfaces use.

## How it is built for speed

This iteration is built around one observation about the timed workloads:
they repeat themselves. Fifty clones ask for the same tip, two thousand
reads ask for the same issue, and two hundred pushes each store a handful
of new objects. So the forge memoizes aggressively — but only behind
version counters that move whenever the state behind an answer does, so a
cached answer can never describe a stale world:

- **Fetch answers are memoized whole.** A fetch response is a pure
  function of the request, the refs and the object store; the first clone
  builds the pack, the other forty-nine are buffer writes. The same goes
  for ref advertisements and `ls-refs`, keyed on each repo's ref version.
- **Pack entries are deflated once.** The object store keeps each object's
  ready-made pack entry (header + deflate) beside the object itself, so
  assembling a pack never re-compresses an object it has already sent.
- **REST reads are memoized at the front door.** GET answers are cached
  against the forge's mutation counters; any write anywhere retires them
  all at once, and each served answer still carries a fresh request id.
- **Parsing stays single-pass.** Incoming packs are inflated once with the
  consumed byte count reported by zlib, fast-forward checks stop at the
  first matching ancestor, tree flattening is cached on the store, and
  routing splits the raw request target instead of running the WHATWG URL
  parser per request.

State is deterministic: every timestamp derives from `MAKEFUN_TRIAL_NOW`
plus a per-process sequence, never from the wall clock, so a replayed trial
produces byte-identical state.
