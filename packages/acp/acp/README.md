---
description: "Automation-only ACP (Agent Client Protocol) server for programmatic clients and maintainers driving DeepSeek Harness agents over JSON-RPC stdio."
kind: "package-reference"
---

# @deepseek-ai/dsh-acp

English | [中文](README.zh.md)

## Summary

`dsh-acp` lets trusted programs automate persistent DeepSeek Harness agents through the standard [ACP](https://agentclientprotocol.com): create or resume sessions, select a model and reasoning effort, attach MCP servers, submit or cancel work, receive semantic updates, and close sessions independently. Choose it for out-of-process subagents, test runners, and scripted controllers; it intentionally omits DSH-specific presentation data and interactive UI features. Persistence supports listing, resuming, and closing sessions across process restarts, but deletion, forks, and additional directories are unsupported. Run `pnpm dsh --profile acp` to start the server; use `dsh-subagent-acp` as the repository client.

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

Use this package when a script, test runner, or another harness needs to run agent work end to end through a standard automation protocol. The common path is: start the server, create or resume a session, optionally mount MCP servers and select model options, send a prompt, consume semantic updates, and close the session.

### When to choose it

Choose it when automation should own the interaction: an out-of-process subagent, test runner, or scripted controller that manages persistent sessions, tools, model selection, and permissions. Avoid it when a human needs DSH-specific presentation cards, plans, titles, todos, terminal views, or elicitation; this server exposes ACP v1 and opt-in draft ACP v2.

### Minimal configuration

Every session the server creates uses the provider and model configured here. Both fields are optional so another agent or request listener can supply them; the runnable demo composition sets both. Stdout carries only protocol traffic, so keep logging off it.

```yaml
- name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | — | Provider route for every session's agent |
| `model` | — | Model for every session's agent |
| `sessionListPageSize` | `100` | Maximum summaries returned in one `session/list` page |
| `experimentalV2` | `false` | Enable draft v2 negotiation while retaining v1 |
| `sessionReplayPageSize` | `256` | Maximum persisted events read per v2 replay page |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-acp) is the exhaustive source for every accepted field and its JSDoc.

### Start a server

`pnpm dsh --profile acp` starts the shipped stdio server. The `acp` profile mounts session persistence, so clients can list, resume, and close persistent sessions. [`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.md) starts the same profile for out-of-process delegation.

<a id="protocol-contract"></a><a id="standard-acp-v1-surface"></a>
### Protocol contract

One connection can run several sessions at once, each independent. The following table describes v1:

| Call | What you get |
|---|---|
| `initialize` | Stable ACP v1 plus `session/list`, `session/resume`, `session/close`, and Streamable HTTP MCP support; image prompts only when the durable attachment store and configured exact route support them. |
| `authenticate` | Immediate success; the server requires no authentication. |
| `session/new` | A fresh persistent agent whose absolute workspace and stdio or HTTP MCP servers are validated before publication, plus its complete configuration-option state. |
| `session/list` | Deterministic newest-first pages of persisted, resumable root sessions; an optional absolute `cwd` filter uses physical-directory identity where possible. |
| `session/resume` | A persisted inactive session whose canonical workspace is verified before composition; its log is restored without replaying old updates. |
| `session/close` | Quiescent cancellation, update draining, descendant disposal, persistence flush, and disposal of only the addressed Agent scope. |
| `session/set_config_option` | A serialized update to the advertised `model` or `reasoning_effort`, returning the complete resulting state. |
| `session/prompt` | Ordered text, resource links, and supported images, one prompt at a time per session; settlement follows root and descendant completion plus ordered update delivery. |
| `session/cancel` / `$/cancel_request` | The prompt-owned cancellation path; without an ACP prompt in flight it cancels autonomous work, while unknown session ids are no-ops. |
| `session/update` | Committed assistant messages and thoughts, generic tool lifecycle, configuration changes, and context usage, serialized per session. |
| `session/request_permission` | A permission prompt with one-shot allow/reject choices; your client can answer automatically. |

Session listing and resume admit ordinary forks, including historical logs with `parentSession`; `origin: subagent` remains excluded.

A prompt remains in flight while managed descendants run, while their results trigger later root turns, and while committed output drains. Root work accepted during that output drain joins the same activity interval before completion. Its completion includes the latest root stop reason and any assistant output delivery failure; only the original prompt turn pins the model selection captured at admission. Cancellation stops the root activity present at that call and waits for that activity and its queued output. Later child messages may start autonomous work and do not delay the cancelled response; the session remains available for later prompts. Idle descendants with parked inbox messages remain resident but do not delay prompt completion. Closing the session also drains its descendants.

A failure to append `turn/start` or `turn/end` rejects the prompt even when a preceding turn completed.

Session configuration offers opaque provider/model choices from the live LLM service catalog and a `reasoning_effort` selector when the exact model declares one. An option change records the Session selection and takes effect at the next model step, including a continuation in the current turn; an already prepared step and its retries keep their captured selection. Image admission checks the selection current when admission begins. Resume restores a recorded selection even when no request has used it yet. ACP clients are trusted controllers: stdio MCP entries authorize their absolute commands and environment, HTTP entries authorize their absolute HTTP(S) URLs and headers, and any initial connection or discovery failure rolls back the unpublished Agent. Unsupported surfaces are omitted or rejected: `session/load`, deletion, fork, additional directories, SSE or ACP-transport MCP, modes, commands, plans, terminals, client filesystem operations, and elicitation.

### Draft ACP v2

Set `experimentalV2: true` on the ACP plugin's configuration row to allow `initialize` requests with `protocolVersion: 2`. The connection then uses v2 `info` and `capabilities`; v1 clients keep their existing handshake and prompt lifecycle. The pinned SDK `1.7.0` supplies separate v1 and experimental v2 validators and handlers. No unstable extensions or authentication methods are advertised.

Profile patches replace the whole `config` of a targeted row. Include `provider` and `model` alongside `experimentalV2` when ACP owns the initial selection; an overlay containing only the flag removes that selection.

ACP and Web share saved credentials when they use the same Harness home, but their provider definitions are profile-local. To reuse Web model definitions, copy the relevant adapter rows, such as `llm-pi-ai`, from `$DSH_HOME/profiles/web/cordis.patch.yml` into `$DSH_HOME/profiles/acp/cordis.patch.yml`, preserving credential references, and set the ACP row's `provider` and `model` to a configured route. The default Harness home is `~/.dsh`. Do not copy the entire Web patch, which can reference Web-only plugins. Restart the ACP process after editing; copied definitions do not automatically follow later Web edits. Saved keys remain in the shared [credential store](../../credentials/credentials-local/README.md) and need not be duplicated in the ACP client's environment.

A v2 prompt returns its canonical Harness user `messageId` after validated insertion, before the model finishes. The server emits the accepted user message, then `running`. Permission exchanges report `requires_action`, returning to `running` after the outstanding answers arrive. Completion reports `idle` with a stop reason, including `cancelled` or `error`. `$/cancel_request` owns admission only; after acceptance use `session/cancel`. Each session still admits one foreground prompt at a time.

Committed assistant text and thoughts use whole-message replacement updates; tool calls use `tool_call_update` upserts. User and assistant IDs retain their Harness identities; thought IDs add a deterministic `:thought` suffix to the assistant ID. Model selectors use `configId` and `groupId`. Resume without `replayFrom` reports the current idle state; `replayFrom: { type: "start" }` additionally replays retained user-authored messages, assistant messages, and tool facts from paged storage reads. Injected model context is not a user echo.

The [v2 migration guide](https://agentclientprotocol.com/protocol/v2/migration) and [baseline schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.json) define the draft wire format. Display terminals, plans, commands, and additional workspace roots have no ACP projection; they are not implied by v2 negotiation. The [T3 interoperability test](../../../apps/cli/tests/profiles/acp/tests/t3-interop.e2e.ts) imports an installed checkout selected by `DSH_T3_CODE_ROOT` and verifies a deterministic MCP tool turn over stable v1. Keep `experimentalV2: false` for generic T3 runtimes that only project v1 message chunks: a v2 handshake alone does not establish support for v2 whole-message updates.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the server realizes the behavior above and points at the code that implements it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The server is an automation transport with an intentionally standard public protocol. Three commitments shape it:

- **Standard semantic updates only.** The wire carries committed messages and thoughts, generic tool lifecycle, configuration, and context usage; raw provider deltas, retry attempts, DSH presentation data, and unsupported content stay off the wire.
- **Truthful capability and configuration state.** `initialize` advertises only mounted support, topology changes publish complete configuration options, and a prompt pins the exact route it admitted.
- **Quiescence before completion.** V1 prompt results, v2 terminal states, and close responses wait for their owned work and ordered output to drain; v2 prompt acceptance does not wait for completion.

The decision history lives in the [ACP as an automation-only protocol note](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) and the [multi-session note](../../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `AgentSideConnection` wiring, per-session records, admission and settlement, teardown |
| [`src/content.ts`](src/content.ts) | Wire-content admission and projection: image validation, route recheck, prompt reconstruction, assistant block conversion |
| [`src/codec.ts`](src/codec.ts) | Pure turn-ending to ACP `stopReason` mapping |
| [`src/v2.ts`](src/v2.ts) | Draft v2 content, configuration, and committed-event projections |

### Admission and prompt settlement

Each session permits one in-flight prompt. Admission validates the whole prompt batch, snapshots the selected route, rechecks the exact Agent identity and image capability, persists image attachments, and only then queues the user message — a cancellation that wins admission never enqueues a late turn. Once queued, the session module associates the snapshot with the inbox message until claim and pins the same provider, model, and reasoning effort across prompt variables and every model step in that turn. Per-session update delivery is serialized; committed images are re-read and integrity-verified, so a missing or corrupt image fails the correlated prompt instead of emitting a placeholder. Settlement precedence is explicit cancellation, committed-output failure, interval-wide Agent failure, then the correlated turn ending.

### Teardown and connection ownership

Each session module owns its Agent handle, MCP mounts, future and turn-pinned model selections, prompt slot, update chain, and memoized close operation. Explicit close, client disconnect, and Cordis disposal use the same quiescent teardown: stop new work, cancel prompt admission and Agent activity, drain committed updates, dispose continuable descendants child-first, flush persistence, and release the owned Agent scope. A session close leaves persisted state available for list and resume, and other sessions or frontends sharing the Context remain untouched.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the matching client to the design records behind the automation contract.

- [dsh-subagent-acp](../../subagent/subagent-acp/README.md) — the out-of-process ACP client that spawns and drives this server.
- [ACP as an automation-only protocol](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) — the design record for the automation contract and its wire boundaries.
- [Multiplex concurrent ACP sessions over one connection](../../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md) — per-session isolation, ownership, and teardown decisions.
- [Extension cookbook](../../../docs/cookbook/extension-cookbook.md) — this package as the automation-only worked example for extension authors.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt content

#### What the model sees

`session/prompt` preserves text and image order in one user message: adjacent text concatenates, and a resource link appears as a bracketed `[resource_link name=… uri=…]` reference the model may open with its own tools. Inline image base64 is discarded after batch admission, so the durable message contains only verified attachment references. Protocol metadata, client capabilities, permission choices, and session ids never enter the model request.

#### Token effect

Prompt content, tool calls/results, and durable image references remain in that session until compaction. Concurrent sessions retain independent contexts.

#### KV Cache effect

Append-only while the selected route and assembled prefix stay unchanged. A model change starts the next ACP turn on the new route.

### Permission decisions

#### What the model sees

Nothing directly. The owning tool records its allowed, rejected, cancelled, or unavailable outcome through the normal tool-result path.

#### Token effect

Only the owning tool result contributes tokens.

#### KV Cache effect

Append-only through the owning tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a protocol comparison or a task backlog.

- **One primary workspace** — additional directories remain unsupported.
- **Raster prompt images only** — PNG, JPEG, WebP, and GIF require a durable attachment store and an exact image-capable route.
- **MCP tools only** — MCP resources and prompts have no DSH consumer.
- **V1 has no transcript replay; interactive extensions are unsupported** — session deletion, fork, `session/load`, modes, commands, plans, terminals, client filesystem operations, and elicitation remain outside this automation surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
