---
description: "Automation-only ACP (Agent Client Protocol) server for programmatic clients and maintainers driving DeepSeek Harness agents over JSON-RPC stdio."
kind: "package-reference"
---

# @deepseek-ai/dsh-acp

English | [中文](README.zh.md)

## Summary

`dsh-acp` lets trusted clients drive persistent DeepSeek Harness agents through standard [ACP](https://agentclientprotocol.com): create, resume, or fork sessions; choose models and planning modes; run tools; review permissions; and answer questions. Clients receive file diffs, command results, titles, and draft-v2 live shell output. Choose it for editor integrations, out-of-process subagents, and scripted controllers. Run `pnpm dsh --profile acp` to start the server; use `dsh-subagent-acp` as the repository client.

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

Choose it when an ACP client owns the interaction and renders standard tool cards and questions. The server exposes ACP v1 and negotiated draft ACP v2; DSH-specific Web components and persistent terminal control remain outside this interface.

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
| `protocolV2` | `true` | Negotiate draft v2 alongside stable v1 |
| `sessionReplayPageSize` | `256` | Maximum persisted events read per transcript replay page |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-acp) is the exhaustive source for every accepted field and its JSDoc.

### Start a server

`pnpm dsh --profile acp` starts the shipped stdio server with session persistence and the required Session projection registry. Clients can list, resume, fork, and close persistent sessions. [`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.md) starts the same profile for out-of-process delegation.

> **Warning — full-access deployments:** Setting `sandbox-policy.config.mode: danger-full-access` removes Harness filesystem confinement for local commands and file tools; the host account's permissions still apply. `approval.config.policy: never` disables approval prompts and rejects operations that request approval; it does not automatically approve them. Use these settings only for trusted ACP clients and workloads.

An explicit ACP deployment overlay can set both policies without relying on the launcher's environment:

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()

- id: approval
  config:
    policy: never
```

In T3 Code's environment-value field, enter `danger-full-access` without literal quote characters when setting `DSH_PERMISSION_MODE`. A value containing the characters `'danger-full-access'` fails sandbox-policy validation and can leave dependent shell and file tools unavailable; a client's full-access label does not verify Harness plugin activation. Restart the ACP provider after changing its environment or overlay. Resumed sessions retain their recorded permission policies; verify the effective session settings and native tool availability before relying on the change.

<a id="protocol-contract"></a><a id="standard-acp-v1-surface"></a>
### Protocol contract

One connection can run several sessions at once, each independent. The following table describes v1:

| Call | What you get |
|---|---|
| `initialize` | Stable ACP v1 plus session lifecycle and Streamable HTTP MCP support; compatible attachment storage enables image transport independently of the initial model. |
| `authenticate` | Immediate success; the server requires no authentication. |
| `session/new` | A fresh persistent agent whose absolute workspace and stdio or HTTP MCP servers are validated before publication, plus its complete configuration-option state; the command list follows the response. |
| `session/list` | Deterministic newest-first pages of persisted, resumable root sessions; an optional absolute `cwd` filter uses physical-directory identity where possible. |
| `session/load` | Restore an inactive persistent session and replay retained conversation messages, tools, and task plans before returning; requests for the session fail until then, and later events follow the replay. |
| `session/resume` | A persisted inactive session whose canonical workspace is verified before composition; its log is restored without replaying old updates. |
| `session/close` | Quiescent cancellation, update draining, descendant disposal, persistence flush, and disposal of only the addressed Agent scope. |
| `session/set_config_option` | Update an advertised model, reasoning effort, or composed `collaboration_mode` selection and return the complete resulting state. |
| `session/prompt` | Ordered text, resource links, and supported images, one prompt at a time per session; settlement follows root and descendant completion plus ordered update delivery. |
| `session/cancel` / `$/cancel_request` | The prompt-owned cancellation path; without an ACP prompt in flight it cancels autonomous work, while unknown session ids are no-ops. |
| `session/update` | Committed messages, tool presentations, configuration, usage, and `session_info_update` titles, serialized per session. |
| `session/request_permission` | A permission prompt with one-shot allow/reject choices; your client can answer automatically. |

`session/fork` creates an independent persistent Agent from a committed source snapshot, inheriting recorded model and plan selections while mounting fresh MCP connections. Active sources must be idle with no prompt, command, or permission exchange in flight. The child inherits no live processes or pending inputs. Listing and resume admit ordinary forks, including historical logs with `parentSession`; `origin: subagent` remains excluded.

A prompt remains in flight while managed descendants run, while their results trigger later root turns, and while committed output drains. Root work accepted during that output drain joins the same activity interval before completion. Its completion includes the latest root stop reason and any assistant output delivery failure; model option changes take effect at the next model step. Cancellation stops the root activity present at that call and waits for that activity and its queued output. Later child messages may start autonomous work and do not delay the cancelled response; the session remains available for later prompts. Idle descendants with parked inbox messages remain resident but do not delay prompt completion. Closing the session also drains its descendants.

A failure to append `turn/start` or `turn/end` rejects the prompt even when a preceding turn completed.

Session configuration offers provider-grouped model choices and reasoning effort from the live LLM catalog. Model changes apply at the next model step; prepared steps and retries keep their captured selection. Every image prompt validates the currently selected model before storing attachments, so switching to a vision model needs no new connection. Switching to a text-only model makes subsequent image submissions fail explicitly. MCP declarations authorize their commands, environments, URLs, and headers; initial connection or discovery failure rolls back the unpublished Agent.

### Tool presentation and human decisions

Registered tool presenters supply standard tool names, kinds, absolute locations, file diffs, and shell exit status. Permission requests reuse that presentation and raw input so clients can apply operation policies. Unknown tools retain `other` and their raw arguments. Permissions offer one-shot allow/reject choices only; a command approval never grants every later invocation of that tool.

When plan mode is composed, the `collaboration_mode` selector offers `plan` and `build`. Changes during an open turn apply at its next accepted step. This selection changes planning guidance, not sandbox permissions. `exit_plan_mode` presents the plan as a one-shot permission review; approval leaves plan mode through the plan service.

Clients that negotiate form elicitation can answer human questions through `elicitation/create`, including multiple selections and optional custom text. The bridge mounts `ask_user_question` in negotiated sessions when the question and tool services are available, preserving an existing tool registration. Fixed approval questions accept only their offered choice. Plan review uses the permission channel instead. Host question deadlines cancel pending exchanges; late answers are ignored, and an unsupported client does not receive an unadvertised form request.

Draft v2 streams retained shell-job output with `tool_call_content_chunk`. Each job keeps one pending bounded ring snapshot during transport backpressure; gaps are reported rather than silently joined. The final tool result replaces the preview with authoritative content. V1, deployments without jobs, and foreground shell paths with `promoteOnTimeout: false` deliver output only at completion.

<a id="slash-commands"></a>

### Slash commands

Send a registered slash command as text in `session/prompt`, for example `/goal finish the task`, `/goal`, `/goal edit revised objective`, `/goal pause`, `/goal resume`, or `/goal clear`. The bridge executes the receiving Agent's command registry directly; command input and output do not enter model history. The shipped profile includes the goal service and automatic round driver, so creating or resuming a goal starts work. Commands accept text only; accompanying images or resource links are rejected before execution. Unrecognized slash commands remain ordinary model prompts.

V1 announces the complete command list through `available_commands_update` after the `session/new` response and before the `session/load` or `session/resume` response, so the client always knows the session ID first; v2 returns `availableCommands` in those responses. Registry changes replace the list. Command results use standard assistant text updates. V1 returns `end_turn` after the command result is delivered, without waiting for automatic goal rounds. V2 echoes the command with a live-only user message ID and returns that ID; this echo and its direct result are not replayed. The command registry persists its own lifecycle events and the goal service persists accepted mutations.

A command can inspect, pause, or edit a goal during a foreground prompt or automatic round. Each session accepts one command at a time and rejects ordinary prompts during command execution. Automatic rounds publish v2 activity states independently of command acknowledgements. `session/cancel` stops active goal work through the existing cancellation path and aborts a running command, which then settles like a cancelled prompt: v1 returns `cancelled` and v2 rejects the request without an echo; closing the session cancels and drains commands before releasing the Agent. A custom composition without a command registry advertises no commands.

### Goal status and task plans

Goal mutations, activation changes, and admitted rounds publish standard assistant text with the objective, phase, continuation eligibility, round count, and any blocking reason. Loading or resuming publishes the current goal status without arming a restored goal; `/goal resume` explicitly restarts automatic work. These status messages are transport output and do not enter model history. A command's own result reports the mutation it made; status text is not repeated for that command and covers autonomous changes and restoration.

Persisted `todo/write` lists become complete ACP plans: v1 `plan` updates and v2 `plan_update` item lists with the session-local ID `todos`. Priorities are `medium` because DSH tasks have no priority field. A new turn clears the previous list; resume restores a current list, and history loading replays its replacements. Planning mode and plan document previews remain separate from task-list progress.

### Draft ACP v2

ACP enables v2 negotiation by default; set `protocolV2: false` only for a v1-only deployment. A client requesting `protocolVersion: 2` receives v2. The connection then uses v2 `info` and `capabilities`; v1 clients keep their existing handshake and prompt lifecycle. Both handshakes report the agent name `deepseek-harness-acp` and this package's version. The pinned SDK `1.7.0` supplies separate v1 and experimental v2 validators and handlers. No authentication methods are advertised.

Profile patches replace the whole `config` of a targeted row. Include `provider` and `model` alongside `protocolV2` when ACP owns the initial selection; an overlay containing only the flag removes that selection.

A v2 prompt returns its canonical Harness user `messageId` once its turn commits the message to the conversation, before the model finishes; a prompt queued behind other work is not yet accepted, and one cancelled or removed before the commit fails its request without an echo. The server echoes the committed user message, then `running`. Permission exchanges report `requires_action`, returning to `running` after the outstanding answers arrive. Completion reports `idle` with a stop reason, including `cancelled` or `error`; a failed turn also carries its failure message in `_meta.error` rather than as transcript text. `$/cancel_request` cancels a prompt until its commit; after acceptance use `session/cancel`. Each session still admits one foreground prompt at a time.

Committed assistant text and thoughts use message chunks with stable IDs; tool calls use `tool_call_update` upserts. User and assistant IDs retain their Harness identities; thought IDs add a deterministic `:thought` suffix to the assistant ID. Model selectors use `configId` and `groupId`. Resume publishes the restored goal status and standing plan, then the current idle state; `replayFrom: { type: "start" }` first replays retained user-authored messages, assistant messages, tool facts, and plan replacements from paged storage reads. Live delivery and replay echo the same committed user-authored messages; injected model context is not a user echo.

The [v2 migration guide](https://agentclientprotocol.com/protocol/v2/migration) and [baseline schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.json) define the draft wire format. Display terminals and additional workspace roots have no ACP projection; they are not implied by v2 negotiation. The [T3 interoperability test](../../../apps/cli/tests/profiles/acp/tests/t3-interop.e2e.ts) uses a checkout selected by `DSH_T3_CODE_ROOT` to exercise the generic ACP runtime. It self-skips when no checkout is configured. T3's `prompt()` waits for idle, so cancel a running goal before issuing another prompt through that API.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the server realizes the behavior above and points at the code that implements it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The server is an automation transport with an intentionally standard public protocol. Three commitments shape it:

- **Standard semantic updates.** Registered tool presenters supply kinds, locations, diffs, command exit status, and permission subjects; unknown tools retain generic cards. Transient job output is a preview, while committed results remain authoritative.
- **Truthful capability and configuration state.** `initialize` advertises only mounted support, topology changes publish complete configuration options, and model option changes take effect at the next model step.
- **Quiescence before completion.** V1 prompt results, v2 terminal states, and close responses wait for their owned work and ordered output to drain; v2 prompt acceptance does not wait for completion.

The decision history lives in the [ACP as an automation-only protocol note](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) and the [multi-session note](../../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, protocol routing and handshakes, per-session records, listener wiring, teardown |
| [`src/session.ts`](src/session.ts) | One session's Agent, commands, prompt admission and settlement, ordered updates, replay, and progress |
| [`src/content.ts`](src/content.ts) | Wire-content admission and projection: image validation, route recheck, prompt reconstruction, assistant block conversion |
| [`src/output.ts`](src/output.ts) | Protocol-neutral update delivery and its stable-v1 implementation |
| [`src/updates.ts`](src/updates.ts) | Standard v1 projections of committed session events for live delivery and history replay |
| [`src/codec.ts`](src/codec.ts) | Pure turn-ending to ACP `stopReason` mapping |
| [`src/tool-projection.ts`](src/tool-projection.ts) | Registered tool presentation and permission subjects |
| [`src/job-output.ts`](src/job-output.ts) | Bounded independent observation of live job output |
| [`src/questions.ts`](src/questions.ts) | Form schemas, answer validation, and cancellation |
| [`src/v2.ts`](src/v2.ts) | Draft v2 content, configuration, and committed-event projections and update delivery |

### Admission and prompt settlement

Each session permits one in-flight prompt. Admission validates the whole prompt batch, snapshots the selected route, rechecks the exact Agent identity and image capability, persists image attachments, and only then queues the user message — a cancellation that wins admission never enqueues a late turn. The Agent owns model selection; each prepared step captures its provider, model, and reasoning effort, while later steps observe accepted option changes. Per-session update delivery is serialized; committed images are re-read and integrity-verified, so a missing or corrupt image in assistant output or a tool result fails the foreground prompt instead of emitting a placeholder. A transport write failure is logged and left to connection teardown on both protocols. Settlement precedence is explicit cancellation, committed-output failure, interval-wide Agent failure, then the correlated turn ending.

### Teardown and connection ownership

Each session module owns its Agent handle, MCP mounts, model configuration, prompt slot, update chain, and memoized close operation. Explicit close, client disconnect, and Cordis disposal use the same quiescent teardown: stop new work, cancel prompt admission and Agent activity, drain committed updates, dispose continuable descendants child-first, flush persistence, and release the owned Agent scope. A session close leaves persisted state available for list and resume, and other sessions or frontends sharing the Context remain untouched.

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

Prompt content, tool calls/results, and durable image references remain in that session until compaction. Selected plan mode adds the plan service’s guidance to model requests. Human answers reach the owning tool result; live output previews add no model tokens. Concurrent sessions retain independent contexts.

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
- **Unsupported protocol operations** — session deletion, additional roots, SSE or ACP-transport MCP, persistent terminal control, client filesystem operations, and URL elicitation are not projected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
