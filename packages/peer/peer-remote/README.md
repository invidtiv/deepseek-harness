---
description: "The HTTP Remote-API peer transport for users and maintainers pointing this Harness at another Harness instance."
kind: "package-reference"
---

# @deepseek-ai/dsh-peer-remote

English | [中文](README.zh.md)

## Summary

`dsh-peer-remote` registers one peer Harness transport on `ctx.peers`. It speaks the peer's Remote API over `/api`, authenticating every call with a browser-session cookie resolved per request, and turns the peer's own session log into the completed answer a caller asked for. One plugin row is one peer; register one row per Harness you want to drive.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the seam, this transport once per peer, and a consumer. The peer must already run a web surface that this machine can reach — for example `dsh web` published on a tailnet by `tailscale serve` — and you need one browser-session cookie for the exact authority you dial.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `peerId` | required | Peer name every consumer and tool argument uses. |
| `baseUrl` | required | Peer web origin, for example `https://build-box.tailnet.ts.net:8443`. Its origin form is what the transport dials. |
| `cookieEnv` | `DSH_PEER_COOKIE` | Credential reference holding this peer's browser-session cookie. |
| `defaultCwd` | none | Peer working directory used when a request names none. |
| `defaultAgentPreset` | none | Peer agent preset used when a request names none. |
| `requestTimeoutMs` | `60000` | Bound on one unary Remote call. |
| `askTimeoutMs` | `180000` | Bound on waiting for one peer turn to end. |
| `pollIntervalMs` | `2500` | Delay between turns of the peer completion poll. |

```yaml
- name: '@deepseek-ai/dsh-peer-remote'
  config:
    peerId: build-box
    baseUrl: https://build-box.tailnet.ts.net:8443
    cookieEnv: DSH_PEER_BUILD_COOKIE
    defaultCwd: /srv/work
    defaultAgentPreset: standard
```

### Credentials

The cookie resolves through `ctx.credentials` under `cookieEnv`, falling back to the launch environment when no credentials provider is mounted. A peer whose credential is missing fails at the first call with a message naming the peer and the reference, rather than dialing anonymously.

### How one task runs

An `ask` creates a peer session (unless the request names an existing one), records the session's log cursor, admits the prompt, then polls that session until a turn end appears after the recorded cursor. The result carries the final assistant text, the peer's stop reason, elapsed time, and any token usage the peer reported. A peer that never ends a turn within `askTimeoutMs` fails with a message naming the peer and session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One row, one peer.** The plugin registers exactly one transport; scaling to several peers is several rows.
- **The Remote envelope is the wire.** Each call posts `{ type, rpcId, method, payload: { args } }` and validates the matching `server-response` before reading a value.
- **The peer's log is the source of truth.** Completion is a `turn/end` event after the recorded cursor, not a transport-level acknowledgment.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: configuration, credential resolution, transport registration |
| [`src/remote.ts`](src/remote.ts) | `RemotePeerTransport`: the Remote calls, session polling, and wire validation |
| — | No runtime invariant companion is published. The transport owns no durable local state; its observable behavior is a function of the peer's responses and is covered by the transport's boundary tests. |

### Reserved list argument

The peer's session-list call takes one reserved request parameter whose wire name comes from the peer Host's own method signature. A Host launched from source names it from the live function while a generated Host may differ, so the transport tries both spellings before failing and reports the first failure when neither works.

### Request policy

Credential-bearing requests disable redirect following, so a peer that answers with a redirect cannot forward the cookie to another origin.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-peer`](../peer/README.md) — the registry this transport registers into.
- [`tool-peer`](../tool-peer/README.md) — the model-facing tools that drive a registered peer.
- [API Gateway](../../../docs/api-gateway.md) — the Remote envelope, endpoint ownership, and argument validation these calls rely on.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-peer`, which renders the peer answer, its stop reason, and the session it ran on.

#### KV Cache effect

No direct effect: the transport adds nothing to this Harness's requests, and the consumer's result follows the reusable request prefix.

## Known Limitations and Deferred Work

- **Completion is polled.** A peer turn is detected by re-reading the peer's session list and log, so a long turn holds one call open for its whole duration and a caller cannot watch it progress.
- **No cancellation of a peer turn.** Cancelling this Harness's call stops the local wait; the peer's own turn continues until it ends.
- **Cookies are authority-bound.** A cookie minted for one origin does not authenticate another, so a peer reached by two addresses needs one credential per address.
- **Structural wire validation only.** Peer payloads are read for the fields this transport consumes; peer-version-specific fields are ignored rather than negotiated.
- **One peer per row.** Registering the same `peerId` twice fails at registration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
