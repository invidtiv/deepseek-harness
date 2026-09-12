---
description: "The peer Harness seam for users and maintainers registering a remote Harness, choosing a transport, or debugging peer operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-peer

English | [中文](README.zh.md)

## Summary

`dsh-peer` is the seam for driving other DeepSeek Harness instances. It provides `ctx.peers`: a named registry of transports plus the peer operations every consumer addresses by name — list a peer's sessions, run a task on a peer and wait for its turn to end, and read a peer transcript. A composition mounts this service together with at least one transport package; mounting the service alone changes nothing, because nothing can reach a peer until a transport is registered.

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

Mount the service, mount one transport per peer, and mount a consumer that reaches it. The transports available today are listed in [Further Exploration](#further-exploration).

### Registering peers

```yaml
- name: '@deepseek-ai/dsh-peer'
- name: '@deepseek-ai/dsh-peer-remote'
  config:
    peerId: build-box
    baseUrl: https://build-box.tailnet.ts.net:8443
    cookieEnv: DSH_PEER_BUILD_COOKIE
    defaultCwd: /srv/work
    defaultAgentPreset: standard
- name: '@deepseek-ai/dsh-tool-peer'
```

Each transport row registers one peer under its configured `peerId`. Two rows with the same name fail at registration with `DUPLICATE_PEER`.

### Addressing a peer

Every operation takes an optional peer name. Omitting it is legal only while exactly one transport is registered: with none, an unnamed operation fails with `NO_PEER`; with several, it fails with `AMBIGUOUS_PEER` and names the candidates. A name that is not registered fails with `NO_PEER` rather than falling back to another peer.

### Configuration

This package has no configuration of its own. Each transport owns its endpoint, credential reference, and bounds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One service, many transports.** The service is a named registry; a transport package implements the protocol and registers itself.
- **Selection fails loud.** A missing or ambiguous peer name raises a {@link PeerError} instead of guessing.
- **Trusted same-process values.** Requests and results are borrowed immutable values; the transport owns serialization and hostile-input validation at its wire boundary.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PeerService`: the registry, peer selection, and the three operations |
| [`src/types.ts`](src/types.ts) | `PeerTransport`, the request/result vocabulary, and session summaries |
| — | No runtime invariant companion is published: the registry mutates one map through `register`/dispose, so a probe would only re-execute the implementation. The transport and tool packages own their own boundary behavior. |

### Registration lifecycle

`register()` contributes through `ctx.effect`, so unloading the transport row removes exactly that peer and leaves accepted operations to settle against the transport they already hold.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`peer-remote`](../peer-remote/README.md) — the HTTP Remote-API transport for one peer Harness per plugin row.
- [`tool-peer`](../../peer/tool-peer/README.md) — the model-facing `peer_ask`, `peer_sessions`, and `peer_transcript` tools.
- [Peer subsystem](../../../docs/subsystems/peer.md) — the registry, transport contract, and operation types.
- [API Gateway](../../../docs/api-gateway.md) — the Remote call envelope and endpoint ownership a transport speaks.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-peer`, which turns each peer operation into one bounded model-facing tool result.

#### KV Cache effect

No direct effect: the registry adds nothing to a request, and the consumer's own result follows the reusable request prefix.

## Known Limitations and Deferred Work

- **No discovery.** Peers are declared in composition; the registry never probes the network for reachable Harnesses.
- **No incremental observation.** A peer turn is observed by the transport's own polling of the peer's session log, so a caller sees a settled result rather than a live event stream, and nothing from the peer enters this Harness's session log beyond the calling tool's own result.
- **Transports are trusted same-process values.** A transport that throws propagates to its caller; the registry does not isolate one peer's failure from another.
- **No live peer handles.** The seam exposes buffered operations only. Resuming or steering one peer session across many calls is expressed by naming its session id again, not by holding a handle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
