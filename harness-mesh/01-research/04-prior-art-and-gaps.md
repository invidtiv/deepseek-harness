---
description: "Every existing DSH surface that already solves part of cross-machine linking, the exact gap each leaves, and which pieces the mesh plan reuses versus replaces."
kind: "research"
---

# Prior art in the harness, and the gap each leaves

The harness already contains six things that look like they solve part of this problem. This document states what each one does, what it does not do, and whether the mesh plan reuses or replaces it. The reuse column is the important one: three of these are load-bearing for the plan.

## Summary

| Surface | Reused? | What the mesh takes from it |
|---|---|---|
| `ctx.peers` registry | **Reused unchanged** | The mesh registers a `PeerTransport`, so the shipped tools reach mesh nodes with zero changes to those packages. `peer_sessions` and `peer_transcript` work on a fresh pairing; `peer_ask` needs the write grant |
| `RemotePeerTransport` wire format | **Reused as a compatibility mode** | A mesh node can still answer the legacy `/api` path for peers that only speak the shipped transport |
| `ctx.credentials` | **Reused unchanged** | Pairing tokens are stored as `CredentialRecord`s, so resolution, rotation, and the writable-source rules come for free |
| `ctx.subprocess` | **Reused** | `tailscale status --json` and `tailscale serve status` are read through the existing subprocess seam |
| `ctx.webServer` | **Deliberately not used for the mesh listener** | Its host schema has no address a Tailscale interface can bind; the mesh owns its own `node:http` server |
| `packages/ssh/*` | **Used by the test harness only** | Running commands on the Linux box during validation |
| `packages/webhook/*` | **Not used** | GitHub-shaped, one-way, no result channel |
| `packages/sdk/*` | **Not used** | Stdio only |
| `experimental/agent-team` | **Not used** | One process, one checkout, by construction |

## 1. `ctx.peers` — the right seam, missing the credential

`packages/peer/peer` defines the capability: a named registry of transports plus three operations.

**What it gives the plan.** A clean extension point. The plan's remote transport implements `PeerTransport` and calls `ctx.peers.register(...)`, so the shipped model tools reach mesh nodes with no change to `packages/peer/*`.

One nuance the earlier revision missed: the tools do not all work *immediately*, because they do not all map to read operations. `peer_sessions` and `peer_transcript` map to reads, which a fresh pairing allows. `peer_ask` maps to `task.ask`, which is a **write** and is denied until an operator enables it. That is a property of the grant policy, not of the transport, and the phase that implements the transport says so explicitly. That is the whole "command one harness from another" story for the model-facing half, and it costs nothing to reuse.

**The gap it leaves.** `RemotePeerTransport` authenticates with the peer's browser-session cookie, resolved from a credential reference named by `cookieEnv` (default `DSH_PEER_COOKIE`). There is no way to obtain that cookie without a browser:

- The cookie name and its signed payload both bind the exact authority, so a cookie for `127.0.0.1:3080` cannot be used for `box.tailnet.ts.net:443`.
- The only mint path is `GET /?token=<process launch token>`, and the launch token lives in a `WeakMap` on the peer's root context, is never persisted, and is printed only on the peer's own console.
- `packages/client/connection/README.md` states the HTTP carrier accepts no query token outside the root exchange and no `Authorization` header token.

So today's pairing procedure is: start the peer, read the token off its console or open its URL in a browser on the peer or on a machine that can reach it, authenticate, extract the cookie from the browser's storage, and paste it into an environment variable on the other machine. That is what the mesh's pairing flow replaces.

**What the plan does.** A new transport that speaks a mesh protocol over a token the pairing flow minted, *plus* a compatibility path that can still drive a stock `dsh web` peer through the legacy `/api` envelope when a user supplies a cookie. The compatibility path is worth keeping because it means the mesh is additive: an unpaired or older peer is still reachable the way it is today.

## 2. The Remote API and the `/api` fence — a browser API being used as a service API

`peer-remote` drives `session/create`, `session/prompt`, `session/list`, and `session/page` through `POST /api/<namespace>/<method>`.

**Why this is the wrong long-term transport for machine-to-machine.** The `/api` surface is the whole tool-capable Host API, fenced by a browser-trust check that its own source calls "not an auth layer". The decision record for the peer control plane lists the consequences it accepted: the credential grants whatever the Remote API grants, there is no live event stream, no cancellation, and cookies are authority-bound. Each of those is a real cost the mesh can remove rather than inherit.

**What the plan does.** Defines a small, purpose-built protocol on its own listener: a fixed set of operations, each with an explicit grant, a bounded body, a rate limit, a hop counter, and an audit record. It is deliberately *not* a general proxy to `/api`.

## 3. Credentials and settings — correct homes for mesh state

**What it gives the plan.** `ctx.credentials` has exactly the right shape: `modifyRecord` is the only correct write path because a correct write depends on the current value, records are opaque payloads keyed by `<scope>/<id>`, and providers already layer env, stored file, project `.env`, and user `.env`.

**What the plan does.** Stores per-peer pairing records under `mesh/peer/<nodeId>`, holds the *hash* of each issued token on the server side under `mesh/grant/<keyId>`, and puts non-secret node metadata in a `mesh-nodes` settings namespace so the Plugins page can list and edit it.

**Gap.** There is no scope or expiry concept inside a record; a mesh token record therefore carries its own payload schema, versioned, exactly as `BrowserAuth` does with `{version, secret}`.

## 4. The web server — the bind constraint is a feature, not a bug

`ctx.webServer`'s `Config` accepts only `'127.0.0.1'` or `'0.0.0.0'`, and `packages/bundle/web-app/src/startup.ts` refuses `--host 0.0.0.0` with the message that it "would expose remote code execution to the network".

**What the plan does NOT do.** It does not add a host literal for a Tailscale address, and it does not flip the CLI refusal. Both would put the whole GUI, its unauthenticated `/plugins/*` routes, and its tool-capable `/api` on a routable interface.

**What the plan does.** Owns a second listener with a much smaller surface, validated to bind only on a loopback address (for `tailscale serve` to front) or on an address inside the Tailscale CGNAT range `100.64.0.0/10` / `fd7a:115c:a1e0::/48`. A configuration naming any other address fails the load.

## 5. The SDK — stdio, so not a network transport

`JsonRpcLineTransport(input, output)` is newline-delimited JSON-RPC 2.0 over Node streams; production wiring is `process.stdin`/`process.stdout`. Methods are `initialize`, `session/prompt`, `shutdown`; the server pushes `session.event`, `session.status`, `subagent.started`, `subagent.finished`. A grep of `packages/sdk` for `listen(`, `createServer`, `net.`, `http.`, or `socket` matches only test-local fakes.

**What the plan takes from it.** The *shape* of a good remote automation protocol: a small method set, a real initialize handshake carrying `serverInfo`, and server-pushed events. The mesh protocol deliberately mirrors those ideas over HTTP, and reuses the SDK's naming instincts (`session/prompt`, `session.event`) so a future mesh-backed `subagent` provider is a small step. `subagent-dsh-sdk`'s README names that follow-up itself: "a remote runtime would need its own backend."

## 6. Webhook, SSH, agent-team — three near misses

- **Webhook.** HMAC-verified inbound `POST` with a per-request credential resolution, then `Agent.followup()`. But delivery `kind` is hard-coded `'github'`, the response is a `202` with no result, and there is no queue, dedup, retry, or cancel. Reusing it would mean writing a new adapter package anyway, and the harness would gain a second, differently-authenticated way to start sessions.
- **SSH.** The strongest near miss, and the best tool for a different job. `ssh-remote/cordis.yml` and `ssh-multi/cordis.yml` move `ctx.fs`, `ctx.subprocess`, and `ctx.sandbox` to a remote POSIX host, so `bash`, `read`, `write`, `edit`, `glob`, `grep`, terminals, LSP, and PTC all execute remotely. But the agent loop, model transport, session storage, and approvals stay local, and the remote OS must be Linux or macOS. It links *a harness to a machine*, not *a harness to a harness*. It is used by the validation plan for exactly that reason.
- **`experimental/agent-team`.** One process and one shared checkout, with a mailbox that its own README says is not cross-process exactly-once. The plans for a multi-machine version would have to replace the mailbox, the roster, and the task board.

## 7. What is genuinely missing, stated once

1. A **headless credential exchange** so two machines can pair without a browser and without a human copying a cookie.
2. A **stable node identity** — the harness has no name for itself. A session id is per-session; the anonymous user id (`$DSH_HOME/.anonymous-user-id`) is per-install telemetry, not a network identity.
3. A **binding surface** for a routable listener that is not the GUI.
4. A **live session stream** from a peer.
5. A **grant policy** narrower than "whatever the Remote API grants".
6. **Loop and budget control** across nodes.

Each of the six becomes a named component in [the architecture](../02-proposal/02-architecture.md).
