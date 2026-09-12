# Agent Note: Peer Harness control plane

Status: implemented

English | [中文](2026-09-12-peer-harness-control-plane.zh.md)

## Problem

One Harness can delegate inside its own process or to a child process on the same machine, but nothing lets it drive a **different Harness instance on another machine**. Operators run several instances on separate hosts joined by a private network, and want an agent on one host to hand a complete task to an instance on another, see what that instance has been working on, and read what it concluded. The Remote API already carried every one of those operations for the browser Client; no non-browser consumer existed, and the only credential flow was the browser-shaped token exchange.

## Decision

`packages/peer/` is a capability seam with the standard three roles. `@deepseek-ai/dsh-peer` is the Service Definition: `ctx.peers` is a named registry of transports plus the operations every consumer addresses by peer name — `listSessions`, `ask`, and `transcript`. `@deepseek-ai/dsh-peer-remote` is the transport: one plugin row registers exactly one peer Harness and speaks its Remote API over HTTP. `@deepseek-ai/dsh-tool-peer` is the Consumer: the model-facing `peer_ask`, `peer_sessions`, and `peer_transcript` tools.

### The wire it speaks

Each call posts `{ type: 'client-request', rpcId, method, payload: { args } }` to `<baseUrl>/api/<namespace>/<method>` and accepts only the matching `{ type: 'server-response', rpcId, result }` envelope. A failure result carries the peer's own code and message unchanged. The credential is the peer's browser-session cookie, sent as a `cookie` header.

### Completion is a peer log fact

The transport reads the peer's session list, records that session's log cursor, admits the prompt, and polls until a `turn/end` event appears after the recorded cursor. The result carries the last `assistant/message` text, the peer's stop reason, elapsed time, and any usage the peer reported. Nothing is inferred from a transport-level acknowledgment.

### Configuration and credentials

A transport row carries `peerId`, `baseUrl`, and a `cookieEnv` credential reference. The cookie resolves through `ctx.credentials` and falls back to the launch environment when no credentials provider is mounted. Requests that carry the cookie disable redirect following, so a peer cannot forward the credential to another origin.

### Names are configuration, session ids are passthrough

A peer name is authored in composition and behaves like a provider name, and a peer session id is an opaque value this Harness never interprets. Neither is branded, unlike identities this Harness mints and resolves.

### Peer work does not enter this session's log

The peer owns its own session log, model route, and tools. What crosses back is one settled answer and the reads a caller explicitly asks for, so a peer's reasoning and tool traffic never reach the calling session's transcript.

## Alternatives considered

**Extend the subagent seam with a remote provider.** The subagent provider contract is a child run with a settled result; the peer surface also needs reads of the peer's *own* sessions, which are not delegation at all. A remote subagent provider stays a reasonable follow-up and could reuse this transport.

**Drive the peer over SSH stdio through ACP or the headless profile.** This needs no listener and no stored credential, but every call becomes a new remote process, each peer needs a server-side profile and a forced command, and session listing and transcript reads have no equivalent. The Remote API already exists and carries all of them.

**Keep the control plane browser-only.** The remote surface stays human-driven and no agent can call it.

**Bind the peer's web surface to all interfaces.** `dsh web` refuses `--host 0.0.0.0` precisely because that exposes remote code execution to the network. This transport adds no listener of its own and assumes the operator already reached the peer over a private network or a tunnel.

**Ship the working dynamic Cordis Plugin instead of packages.** Dynamic Packages are process-local and disappear when the process restarts. The dynamic Package proved the protocol; the seam is made permanent.

## Consequences

The harness gains a model-facing control plane across instances: a peer is selected by name and ambiguous or missing selection fails loud, the credential never enters a configuration file, every result is bounded before it reaches the model, and the protocol sits behind one registry so another transport can replace it.

The costs are explicit. A peer call blocks for its whole turn because completion is polled; there is no live event stream from the peer and no way to cancel a peer turn already admitted; cookies are authority-bound, so one peer reached at two addresses needs two credentials; and the transport validates the fields it consumes rather than negotiating a peer version.

One consequence belongs to operators rather than code. The credential grants whatever the peer's Remote API grants. An instance whose API-created sessions run with full file access and approvals disabled turns a leaked cookie into unattended execution on that host. This transport adds no listener and refuses redirects, but it cannot fix the peer's own posture.

## Testing

Registry selection, effect-scoped registration and disposal, and the peer operations are covered by unit specs in each package. The transport's wire behavior is covered against a real local HTTP server that speaks the Remote envelope, including credential refusal, a non-envelope response, a peer error result, and the reserved-argument retry.
