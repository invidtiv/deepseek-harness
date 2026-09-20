---
description: "The mesh architecture: components, identity, topologies, the normative route and authentication table, operation flow, grants, and the failure model."
kind: "proposal"
---

# Architecture

## The one idea that makes this cheap

A mesh node already has a fully capable Remote API on its own loopback interface, and the harness already exposes the Host-side call that mints a browser session for it: `ctx.connection.authenticatedUrl(baseUrl)` returns the `/?token=...` URL, and a plain `GET` against it with `redirect: 'manual'` yields the `set-cookie`.

So a mesh node **mints its own loopback browser session at startup**, in memory, and drives its own `/api` exactly as a local browser would — including `session/follow` over the existing WebSocket mux at `/api/remote.mux`.

That decision collapses most of the work: no change to `packages/client/connection` or `packages/api/gateway`; live follow, cancellation, search, and forks come for free because they are already Remote methods; the mesh owns all policy; and the node's network posture is unchanged. The listener is a policy-enforcing, authenticated doorway in front of an API the node already trusts itself to use.

## Components

```
                    tailnet (WireGuard, MagicDNS, ACLs)
   ┌──────────────────────────────┴──────────────────────────────┐
   │                                                             │
┌──┴──────────────── node A ────────────────┐   ┌──────── node B ─┴─────────────┐
│  dsh web  ──  127.0.0.1:3080  (unchanged) │   │  dsh web ── 127.0.0.1:3080    │
│                                           │   │                               │
│  @deepseek-ai/dsh-mesh                    │   │  dsh-mesh                     │
│    identity · registry · pairing · policy │   │                               │
│    durable audit · tailscale entry        │   │                               │
│            │                              │   │                               │
│  dsh-mesh-ops   (the operation map;       │   │                               │
│                  owns the self-session)   │   │                               │
│            │                              │   │                               │
│  dsh-mesh-agent (the inbound listener)    │◄─►│                               │
│    /mesh/v1/...  unix socket | loopback | │   │                               │
│                  this node Tailscale addr │   │                               │
│            │                              │   │                               │
│  dsh-mesh-remote  (PeerTransport)         │   │                               │
│            └──► own /api + /api/remote.mux│   │                               │
└───────────────────────────────────────────┘   └───────────────────────────────┘
```

| Package | Role | Owns |
|---|---|---|
| `dsh-mesh` | Service Definition | identity, node registry, pairing state machine, policy, durable audit, and the `/tailscale` entry |
| `dsh-mesh-ops` | Provider | **every operation implementation**, over the self-session |
| `dsh-mesh-agent` | Provider | the inbound listener: HTTP boundary, authentication, dispatch |
| `dsh-mesh-remote` | Consumer + Provider | the outbound `PeerTransport` in `ctx.peers` |
| `dsh-mesh-cli` | Bundle | the `dsh mesh ...` command surface |
| `dsh-tool-mesh` | Consumer | model tools |
| `dsh-api-mesh-controller` | Consumer + Provider | the browser Host API |
| `dsh-client-ui-mesh` | Consumer | the browser surface |

**Operation ownership is split deliberately.** The earlier draft said the agent package implemented the operations while the remote package owned the self-session they call. Package 2 owns the implementations and the self-session; package 3 owns the HTTP boundary and nothing else. There is **no runtime operation registration**: the operation set is a fixed exhaustive map in package 2, because a plugin that could widen the wire surface would make the "closed set" claim meaningless.

## Identity

Every installation has a **node identity**, created once and stored in `ctx.credentials` under `mesh/identity`: a stable random `nodeId`, an Ed25519 keypair, a display name, and a creation time. The fingerprint is `SHA-256` of the public key, shown as eight groups of four base32 characters.

**The key is used, not decorative.** An earlier draft claimed the key signed presence and pairing transcripts while specifying no signature anywhere. It now signs:

- the pairing transcript, so a peer records a **verified** public key at pairing time;
- a challenge response on `/mesh/v1/presence`, and on any request whose grant requires it, so a peer can prove possession of the key it paired with.

**Clone detection.** A byte-identical `$DSH_HOME` copy holds the node id, the key, and every outbound token, so possession alone cannot distinguish the clone from the original. What the mesh detects is **divergence**: the same `nodeId` answering with different challenge state, or the same fingerprint arriving from a different transport identity, raises `MESH_IDENTITY_CONFLICT` and is refused. A clone that never runs concurrently with the original is **undetectable**; the runbook states that and prescribes deleting `mesh/identity` when a home is copied.

## Addressing

A node's advertised address is resolved in this order and all of them are stored:

1. **MagicDNS name** — `<host>.<tailnet>.ts.net`, preferred; it survives address changes.
2. **Tailscale IPv4** — `Self.TailscaleIPs[0]` from `tailscale status --json`.
3. **Tailscale IPv6** — `fd7a:115c:a1e0::/48`, bracketed in URLs, used when no IPv4 is present.

The `tailscale` binary is read through `ctx.subprocess` with a scrubbed environment. A missing binary degrades to manual entry and logs once; it never fails the load. The port has no implicit default at the protocol layer; the shipped composition sets **8737**, and [the environment evidence](../01-research/03-environment-evidence.md) shows 22, 3080, 3773, 8765, and 8766 are already taken on the reference machine.

## Caller identity per topology

This is the section the review demanded, and it is normative. **`tailscale serve` terminates TLS and proxies from the local machine, so the backend's TCP peer is local `tailscaled`, never the remote device.** Source-address controls therefore do not exist under the Serve topologies, and an earlier draft that applied them unconditionally would either have rejected every request or protected nothing.

| | T1 — serve to a unix socket **(default)** | T2 — serve to a loopback TCP port | T3 — direct tailnet bind |
|---|---|---|---|
| Listener binds | a unix socket path | `127.0.0.1:<port>` | this node's Tailscale address |
| Published by | `tailscale serve --https=<p>` | `tailscale serve --https=<p>` | nothing; peers dial the tailnet address directly |
| Transport | HTTPS, certificate by Tailscale | HTTPS, certificate by Tailscale | plain HTTP inside WireGuard |
| Peer address the backend sees | not applicable | `127.0.0.1` for every caller | **the authentic peer address** |
| Serve identity headers | present for user devices, **advisory** | present for user devices, **advisory** | absent |
| Direct local spoofing of those headers | no TCP port exists to connect to | **possible from any local process** | not applicable |
| Per-source rate limiting | unavailable | unavailable | **available** |
| Source pinning during pairing | unavailable | unavailable | **available** |
| `tailscale whois` on the caller | unusable (address is loopback) | unusable (address is loopback) | usable, and optional |

### What the Serve identity headers are, and are not

Serve injects `Tailscale-User-Login`, `Tailscale-User-Name`, and `Tailscale-User-Profile-Pic` for HTTP and HTTPS Serve, and strips inbound copies of them on the Serve path. Tailscale's own documentation states that a caller reaching the backend directly can supply its own values, and recommends binding the backend to localhost as a way to limit tampering to other services on the same machine — a **blast-radius reduction, not an authentication control**.

Three further facts constrain the design:

- **Funnel traffic carries no identity headers at all.**
- **Tagged devices do not get identity headers populated**, and the tailnet this plan was written against contains several tagged devices.
- When the identity lookup fails, the headers are **absent**, not empty.

The rule that follows is absolute: **a proxy-supplied identity is never an authorization input.** It is rendered as a *claimed* identity in the approval dialog and written as a *claimed* field in the audit record, and it is never compared, matched, or trusted. Authorization is the PAKE-established bearer token and nothing else.

`X-Forwarded-For` is the only signal that carries the true tailnet client address under T1 and T2, and it is exactly as forgeable as the identity headers; it is treated the same way — advisory, marked claimed, never authoritative.

### The security argument per topology

**T1.** An attacker must (a) reach the published endpoint through Serve, (b) present a valid token, or (c) complete a SPAKE2 pairing with a code obtained out of band plus a human approval. Local processes cannot reach a TCP port because there is none; they would have to connect to the unix socket, whose file permissions are the door. Forged headers change nothing, because nothing authorizes on them.

**T2.** Same argument, with one weakening: any local process can connect to `127.0.0.1:<port>` and forge the advisory headers. It still needs a valid token, so this is a display-and-audit integrity weakness, not an authorization bypass. It is documented rather than mitigated.

**T3.** The strongest topology for caller identity: the peer address is authentic, so per-source limiting, source pinning, and `tailscale whois` corroboration become available. `whois` requires root or the configured operator user, so it is optional corroboration, not a dependency; the plan never requires it.

Under every topology the pairing endpoint's brute-force defence is: a 40-bit single-use code, **at most five attempts per invitation**, a bounded TTL, a global rate limit, and a human approval that shows the claimed identity and the SAS. Because an invitation can be attacked at most five times, the per-invitation success probability is bounded by `5 / 2^40` regardless of how fast an attacker can reach the endpoint.

### Funnel is forbidden

A Funnel-exposed mesh port serves the public internet **and strips identity headers**. The plugin reads `tailscale serve status` at startup and warns prominently; the doctor's `not-funnel-exposed` row is red; the runbook carries the exact command to turn it off. This is a live risk on the reference machine, which currently runs a Funnel listener on TCP port 22.

## Routes and authentication

**This table is normative.** The listener implements exactly these routes; every other path answers an empty `404`. The earlier draft described `/hello`, `/presence`, and `/nodes` inconsistently across three documents; `/nodes` is removed entirely, because a node learns its peers from its own configuration and from the pairing exchange, and asking a peer for a peer list is a disclosure with no use.

| Route | Method | Authentication | Purpose |
|---|---|---|---|
| `/mesh/v1/hello` | `GET` | **anonymous** (token required when `discovery.enabled: false`) | protocol versions, node id, display name, fingerprint, and whether the *caller* is paired |
| `/mesh/v1/pair/start` | `POST` | SPAKE2; no token | pairing message 1 |
| `/mesh/v1/pair/confirm` | `POST` | SPAKE2; no token | pairing message 3 |
| `/mesh/v1/pair/poll` | `POST` | SPAKE2 (`cA`); no token | pairing message 5 |
| `/mesh/v1/pair/ack` | `POST` | Bearer: the staged token from the same handshake | pairing message 6 |
| `/mesh/v1/pair/abort` | `POST` | Bearer: the staged token from the same handshake | compensating revocation |
| `/mesh/v1/presence` | `POST` | Bearer + signed challenge | liveness and key possession |
| `/mesh/v1/rpc/<operation>` | `POST` | Bearer | the closed operation set |
| `/mesh/v1/events/<streamId>` | `GET` (upgrade) | Bearer, verified before the upgrade completes | `session.follow` frames |

The anonymous hello returns a fixed document: `{ protocol, protocols[], nodeId, displayName, fingerprint, paired }`. It never returns sessions, paths, grants, peer lists, addresses, or counts. Every route is exercised anonymously, with a valid token, with an expired token, and with a revoked token by the case inventory.

## The three planes

**Pairing plane** — the four `pair/*` routes, specified in [the pairing protocol](03-pairing-protocol.md).

**Control plane** — `hello` and `presence`. Presence is a heartbeat carrying a signed challenge; the interval and failure threshold have one owner.

**Operation plane** — a closed set of ten operations. Reads are allowed on pairing; writes are denied until an operator enables them.

| Operation | Underlying Remote method | Default |
|---|---|---|
| `node.status` | (local) | allowed |
| `session.list` | `session/list` | allowed |
| `session.read` | `session/page` | allowed |
| `session.transcript` | `session/page`, reduced | allowed |
| `session.follow` | `session/follow` over the mux | allowed |
| `session.search` | `session/search` | **denied** |
| `session.create` | `session/create` | **denied** |
| `session.prompt` | `session/prompt` | **denied** |
| `session.cancel` | `session/cancel` | **denied** |
| `task.ask` | create, prompt, then follow to `turn/end` | **denied** |

## How one cross-node command flows

```
A: model calls mesh_command(node=B, prompt="run the tests", cwd=/srv/x)
   └─ ctx.mesh.resolveSpec(...)  → frozen MeshExecutionSpec (limits = min of node, grant, request)
        ├─ read this session's meshCallChain projection → hops, visited
        ├─ refuse if hops >= maxHops, or B is in visited, or B is self
        ├─ POST https://B.<tailnet>:8444/mesh/v1/rpc/task.ask
        │     Authorization: Bearer <token for B>       X-Mesh-Trace: <uuid>
        │     X-Mesh-Hops: <hops+1>                     X-Mesh-Visited: <csv>
        │
   B:   ├─ read a bounded body, parse the version envelope, parse the task.ask schema ONCE
        ├─ authenticate: hash the token, look up keyId, verify
        ├─ resolveSpec: grant policy against PARSED values → frozen spec
        ├─ write the durable audit record (admitted)
        ├─ execute: session/create (under the grant's confining preset), then session/prompt
        │            the created session logs a mesh/inbound event carrying the call chain
        ├─ follow session/follow until turn/end, bounded by the spec
        └─ 200 { sessionId, answer, stopReason, elapsedMs, usage }
        │
   A:   └─ render the bounded result; audit the outcome; return to the model
```

**The call chain is session state, not a header.** HTTP headers vanish the moment B's model makes its own outbound call, so the earlier draft's loop control would have failed on exactly the case it was written for — a genuine A→B→A nested tool call.

- Admitting a remote turn writes a session event `mesh/inbound` carrying `{ traceId, hops, visited, peerNodeId, protocol }`, declared `ignorable: true` so a build that does not know the type skips it rather than refusing the log.
- A `meshCallChain` **session projection** derives hops and visited from that event, so the value survives a restart and is replayable.
- An outbound command reads the projection for the current session and sends `hops + 1` with this node appended. A session with no call chain starts at zero.
- The serving node refuses at `hops >= maxHops` or when its own id is already in `visited`, **before opening any socket**.

## Grants, and what they are not

A grant is the unit of authorization, created on the node that serves the operations, stored non-secret in a settings namespace, with its token hash in `ctx.credentials` under `mesh/grant/<keyId>`.

Reads default on; writes default off. Budgets, expiry, approval mode, allowed presets, and allowed `cwd` roots are per grant.

**The confinement honesty statement**, which every other document links here:

- `cwdRoots` is a lexical allowlist on the directory a request may **name**, resolved before comparison so symlinks and junctions cannot escape it. It is **not confinement**: an agent started inside an allowed directory can read and write elsewhere with ordinary tools.
- A `session.prompt` against an **existing** session names no `cwd` at all, so every session operation is authorized against the **session's own recorded metadata** — its `cwd` and its owner — never against a caller-supplied field.
- A grant that includes a write operation **must** name a `confinement`: a permission preset or an execution world that actually restricts filesystem and process access. The plugin refuses to load a composition that grants writes without one, and refuses `MESH_CONFINEMENT_REQUIRED` at request time if the named preset has gone.
- A peer with a write operation and a non-confining preset has **remote code execution** on that machine. The shipped default grants no write operation, and the grant editor renders that sentence next to every write toggle.

## Why a dedicated listener

1. **Posture.** The GUI's `/api` is a complete tool-capable Host API, and its `/plugins/*` and static asset routes are unauthenticated anyway. Widening it is what the peer control-plane note explicitly rejected.
2. **Bind.** `ctx.webServer`'s schema has no address a Tailscale interface can bind, and no unix socket mode.
3. **Blast radius.** A listener that speaks a closed operation set has a surface measured in hundreds of lines.

## Failure model

Every cross-node failure is a typed `MeshError` with a stable code.

| Situation | Status | Code the caller sees |
|---|---|---|
| Missing, unknown, malformed, revoked, or expired token | 401 | `MESH_UNAUTHENTICATED` — one collapsed code |
| Authenticated, operation not in the grant | 403 | `MESH_NOT_ALLOWED` |
| Authenticated, `cwd` outside the roots | 403 | `MESH_CWD_DENIED` |
| Authenticated, preset not allowed | 403 | `MESH_PRESET_DENIED` |
| Authenticated, no confining preset available | 403 | `MESH_CONFINEMENT_REQUIRED` |
| Authenticated, session not covered by the grant | 403 | `MESH_SESSION_DENIED` |
| Body or response over the bound | 413 / 502 | `MESH_BODY_TOO_LARGE` / `MESH_RESPONSE_TOO_LARGE` |
| Payload does not match the operation schema | 400 | `MESH_PROTOCOL_MALFORMED` |
| No common protocol version | 426 | `MESH_VERSION_UNSUPPORTED` |
| Identity divergence | 409 | `MESH_IDENTITY_CONFLICT` |
| Hop limit or a repeat in the visited set | 409 | `MESH_HOP_LIMIT` |
| Concurrency or hourly budget exhausted | 429 | `MESH_BUSY` |
| Peer unreachable, Tailscale down, self-session unavailable | 503 | `MESH_UNAVAILABLE` / `MESH_SELF_SESSION_UNAVAILABLE` |
| Audit store unavailable | 503 or degraded | `MESH_AUDIT_UNAVAILABLE` |

The distinct classifications — missing, unknown, revoked, expired — are recorded in the **serving node's own durable audit** by inspecting the presented token's `keyId`. The caller never learns which one it was, which is what makes the collapse honest rather than lossy.

## What this design does not do

- No automatic peer discovery. Nodes are configured by endpoint. The anonymous `hello` is a capability probe, not a sweep.
- No streaming on the outbound `ask`; streaming is the separate `session.follow` operation.
- No legacy cookie-authenticated peers.
- No credential rotation operation; rotation is unpair plus re-pair.
- No confinement of a remote turn beyond what the named preset provides.
- No remote session mirroring into a local session log. A followed remote session is a separate read-only view, because a mirrored event is not a local event and would produce a log that cannot be replayed.
