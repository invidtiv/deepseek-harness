# Agent Note: Mesh — pairing and federation between Harness instances

Status: proposed

English | [中文](2026-09-20-mesh-harness-federation.zh.md)

## Problem

Operators run several DeepSeek Harness instances on different machines joined by a private network, and want them to know each other, share sessions, and drive one another. The peer family already carries the control plane: `ctx.peers` is the seam, `dsh-peer-remote` is an HTTP transport, and `dsh-tool-peer` exposes `peer_ask`, `peer_sessions`, and `peer_transcript`.

What it does not carry is a credential a machine can obtain. The transport authenticates with the peer's browser-session cookie, which is HMAC-signed, bound to one exact authority, minted only by `GET /?token=<per-process launch token>`, and never persisted. Pairing two instances therefore means reading a token off the peer's console, opening its URL in a browser, extracting the cookie, and pasting it into an environment variable. That is neither safe nor automatable, and it breaks when the peer restarts or its address changes.

Three further gaps follow from the same root. There is no non-interactive identity for a node, so nothing can verify that a peer is the peer it claims to be. There is no live session view of a peer, because the transport polls a settled turn. And the credential grants whatever the peer's Remote API grants, with no narrower policy available.

## Proposal

A new `packages/mesh/` family implements a **node identity, a safe code-based pairing handshake, and a policy-enforcing listener** in front of a closed operation set.

**The listener is separate and opt-in.** `dsh web` refuses `--host 0.0.0.0` because its `/api` surface is a complete tool-capable Host API, and `ctx.webServer`'s schema has no address a Tailscale interface can bind. The mesh therefore owns its own `node:http` server, disabled in the shipped composition, able to bind a unix socket, loopback, or the node's own Tailscale address, and never anything else.

**Pairing is SPAKE2, RFC 9382, over edwards25519.** The responder shows an eight-symbol Crockford code; the initiator receives it out of band. Both humans compare a six-digit short authentication string derived from the agreed key, the responder approves, and each side hands the other a durable bearer token sealed under that key. A captured transcript yields no offline verifier, which a plain Diffie-Hellman exchange with the code mixed into a KDF does not provide. The code is never accepted from a command-line argument or a model tool call, because a tool call is durable model-visible history.

**Authorization is the paired token and nothing else.** Under a `tailscale serve` topology the backend's peer is the local proxy, and Serve's identity headers are documented by Tailscale as forgeable by any process that reaches the backend directly; they are absent for Funnel traffic and unpopulated for tagged devices. The mesh therefore records a proxy-supplied identity as *claimed* for display and audit, and never authorizes on it. Per-source rate limiting and source pinning exist only under a direct Tailscale bind, and the design says so rather than applying controls that cannot work.

**Sessions are served by their owner, never mounted.** A node mints its own in-memory loopback browser session through the existing `ctx.connection.authenticatedUrl` host API and drives its own `/api` on a peer's behalf, filtered by grants. Live follow, cancellation, and search come from Remote methods that already exist. Two harnesses never write one session log, and a followed remote session is a separate read-only view rather than events appended to a local log.

**Grants are not confinement, and the proposal says so.** A `cwd` allowlist governs only the directory a request may name; an agent started inside an allowed directory can reach elsewhere with ordinary tools, and a prompt against an existing session names no `cwd` at all. Session operations are therefore authorized against the session's own recorded metadata, and a grant that includes a write operation must name a permission preset or execution world that confines. The shipped default grants no write operation.

## Alternatives considered

**Widen the Web GUI's listener.** Rejected: it reintroduces the exact exposure the peer control-plane note rejected, and `/plugins/*` and static assets are unauthenticated on that surface anyway.

**Publish the GUI with `tailscale serve` and keep the cookie.** Kept only as a future compatibility mode: it still requires a human to harvest a cookie, and a leaked cookie is the peer's whole API.

**Drive the peer over SSH stdio.** Rejected in the peer note already: a new remote process per call, a forced command per peer, and no equivalent for session listing or transcript reads.

**Share `$DSH_HOME/sessions` over a network filesystem.** Rejected: the single-writer guarantee is a kernel `flock` on POSIX and a per-login-session named semaphore on Windows, `flock` is unreliable on NFSv3, the store rejects a root mixing compression suffixes, and the derived search index is documented as single-owner.

**OPAQUE instead of SPAKE2.** `@serenity-kit/opaque` is the only npm PAKE with an independent whitebox audit, and it is the wrong protocol family: OPAQUE is an augmented PAKE whose purpose is protecting a stored registration record, and this flow stores nothing. RFC 9382 section 7 says applications needing augmentation should use OPAQUE, and SPAKE2 does not support it. Named as the fallback if a third-party-audited binary becomes a hard requirement.

**A hand-built X25519 plus HKDF construction with the code mixed in.** Rejected: it leaves a transcript that can be attacked offline against every 40-bit code. The short authentication string detects an active relay, not an offline crack.

**Trust the tailnet and skip application authentication.** Rejected as the only control: a tailnet can contain tagged devices outside the operator's control, ACLs express reachability rather than operations, and `tailscale whois` needs an address the backend does not have under a Serve topology.

## Acceptance criteria

- Two fresh installations pair with one code transfer; the code never appears in a command line, a log, an audit record, or on the wire; a second attempt with the same code fails.
- An attacker who records the whole exchange without knowing the code cannot complete it, and both humans see a different short authentication string.
- A configured node is listed with its identity, endpoint, paired state, and last successful contact, and is marked unreachable when stopped.
- A session owned by one node can be listed, read, followed live while running, resumed from a cursor after a dropped stream with no gap or duplication, and driven by a prompt from the other node.
- Revoking on one node stops that node accepting the peer on the next request; remote cleanup is authenticated and best effort.
- Every cross-node failure reports a code from one table, and the local durable audit distinguishes what the caller deliberately cannot.
- The Web GUI binds loopback on every node, verified by probing a machine where it is actually running.

## Risks

The handshake is the security core and a silent defect in it is the worst outcome; RFC 9382 Appendix B vectors run against this implementation, and the edwards25519 constants are asserted against the published values. A grant that permits a write operation with a non-confining preset is remote code execution, which is why the shipped default grants no write operation and the load fails without a named preset. A node home copied byte for byte is indistinguishable from the original by possession alone, so clone detection is limited to divergence and the runbook prescribes deleting the identity on a copy. macOS is not on the reference tailnet, so its behavior is specified from source and not exercised. The transport is bearer-token based inside WireGuard, so a replay by a party that already holds a token is possible by design, mitigated for writes by idempotency keys and made visible by the audit.
