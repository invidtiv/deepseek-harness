---
description: "The model-facing peer tools for users and maintainers giving an agent the ability to run tasks on another DeepSeek Harness instance."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-peer

English | [中文](README.zh.md)

## Summary

`dsh-tool-peer` turns the peer seam into three model-facing tools. Use `peer_ask` to run a complete task on another Harness and receive its final answer, `peer_sessions` to see what that peer has been working on, and `peer_transcript` to read a peer session's own messages. A peer works in its own checkout with its own model and tools; it receives the task text and nothing else from the calling conversation.

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

Mount the seam, at least one transport, and this consumer where the agent should be able to reach another Harness.

```yaml
- name: '@deepseek-ai/dsh-peer'
- name: '@deepseek-ai/dsh-peer-remote'
  config:
    peerId: build-box
    baseUrl: https://build-box.tailnet.ts.net:8443
    cookieEnv: DSH_PEER_BUILD_COOKIE
- name: '@deepseek-ai/dsh-tool-peer'
  config:
    maxResultBytes: 65536
```

### The three tools

| Tool | What it does |
|---|---|
| `peer_ask` | Runs a task on a peer and returns its final answer. Creates a peer session unless `session_id` names one, and blocks until that turn ends. |
| `peer_sessions` | Lists recent peer sessions: id, title, working directory, running state, and last activity. |
| `peer_transcript` | Reads the recent human and assistant messages of one peer session, oldest first. |

Every tool takes an optional `peer` argument. Omit it while exactly one peer is registered; with several, name one or the call fails with the configured candidates.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxResultBytes` | `65536` | Maximum UTF-8 bytes in one complete peer result. |

The cap applies to the complete rendered result after the summary line and truncation marker, so one oversized peer answer cannot flood the calling context.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Tools own presentation; the seam owns transport.** Each tool validates its arguments, calls `ctx.peers`, and renders a bounded, model-facing result.
- **Results are bounded at the complete value.** Absent optional fields are omitted rather than sent as `undefined`, so the declared output schema holds for every result.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `apply`: the three tool definitions, argument projection, and bounded rendering |
| — | No runtime invariant companion is published: the package registers tools through `ctx.tools` and holds no mutable relation of its own. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-peer`](../peer/README.md) — the registry these tools call.
- [`dsh-peer-remote`](../peer-remote/README.md) — the HTTP transport these tools need for a remote Harness.
- [Subagent capability family](../../subagent/README.md) — delegation inside this machine, which lands a child's result in the calling session as a delegation rather than a peer call.

<a id="model-experience"></a>
## Model Experience

### Peer task result

#### What the model sees

For each `peer_ask`, one tool result carrying the peer's final assistant text, or a fixed line when the peer ended its turn without assistant text, followed by a bracketed facts line: the peer's stop reason, elapsed seconds, token usage when the peer reported it, and the peer session id. `peer_sessions` renders one line per session; `peer_transcript` renders the peer's own user and assistant messages.

#### Token effect

The peer's answer enters the calling session's history and is resent on later turns until compaction replaces it, bounded by `maxResultBytes`. The peer's own reasoning, tool calls, and intermediate steps never enter this session.

#### KV Cache effect

Append-only in the calling session: the result follows the reusable request prefix. The peer's own requests are independent and reuse only prefixes identical under its own composition and history.

## Known Limitations and Deferred Work

- **A peer call blocks.** `peer_ask` holds the calling tool call open until the peer's turn ends, bounded by the transport's ask timeout.
- **No live peer events.** The tools expose settled results and stored messages only; a caller cannot watch the peer work step by step.
- **Peer output is text.** The tools forward text and never inline images, attachments, or tool payloads from the peer.
- **No peer identity in the result.** A result names the session it ran on, not the peer that answered; with several peers registered, the caller distinguishes them by the argument it passed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
