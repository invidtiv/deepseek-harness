---
description: "Package map for the peer Harness family: the named transport registry that drives other DeepSeek Harness instances, the HTTP Remote-API transport, and the model-facing peer tools."
kind: "package-group"
---

# peer/ — drive another Harness instance

English | [中文](README.zh.md)

## Summary

The `peer/` group lets this Harness drive other DeepSeek Harness instances reachable over a network. [`peer/`](peer/README.md) is the seam: a named registry of transports plus the operations every consumer addresses by peer name. [`peer-remote/`](peer-remote/README.md) is the transport that speaks a peer's Remote API over HTTP with a browser-session cookie. [`tool-peer/`](tool-peer/README.md) is the model-facing surface that turns the seam into `peer_ask`, `peer_sessions`, and `peer_transcript`.

A peer works in its own checkout with its own model, tools, and session log. A delegation transfers a complete task, never this Harness's conversation, and the peer's transcript stays on the peer.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The packages below provide the peer family; the package READMEs own the exhaustive contracts.

| Package | Role | ctx key |
|---|---|---|
| [`peer/`](peer/README.md) | Chooses the registered transports and dispatches every peer operation by name. | `ctx.peers` |
| [`peer-remote/`](peer-remote/README.md) | HTTP Remote-API transport for one peer Harness per plugin row. | — |
| [`tool-peer/`](tool-peer/README.md) | Model-facing `peer_ask`, `peer_sessions`, and `peer_transcript`. | — |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the operation types, then the protocol a transport speaks and the in-process delegation family it does not replace.

- [Peer subsystem](../../docs/subsystems/peer.md) — the registry, the transport contract, and the peer operation types.
- [API Gateway](../../docs/api-gateway.md) — the Remote call envelope and endpoint ownership a peer transport speaks.
- [Subagent capability family](../subagent/README.md) — in-process and out-of-process delegation inside one machine, as opposed to another Harness instance.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
