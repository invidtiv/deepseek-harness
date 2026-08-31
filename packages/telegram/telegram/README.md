---
description: "Telegram forum topics as a native DeepSeek Harness frontend: one durable agent session per chat topic, with routing, rendering, approvals, and a workspace fence, for users and maintainers deploying or debugging the bot."
kind: "package-reference"
---

# @deepseek-ai/dsh-telegram

English | [中文](README.zh.md)

## Summary

Telegram forum topics as a native DeepSeek Harness frontend. One durable agent session per chat topic: the plugin long-polls the Bot API, routes every authorized message in a topic to that topic's session (creating, resuming, or refusing with precise errors), renders committed assistant output back into the topic, and answers approval requests and `ask_user_question` items through inline-keyboard buttons. The topic→session mapping is the plugin's own storage-domain unit; session durability, workspace confinement, input queueing, and cancellation stay with the harness.

This package is a transport adapter, not a capability seam or a UI integration. It exposes no editor, transcript, model picker, or terminal surface; the five topic commands are ordinary harness commands, discoverable by any other frontend.

## Table of Contents

- [Plugin](#plugin)
- [Topic → session lifecycle](#topic-session-lifecycle)
- [Workspaces](#workspaces)
- [Workspace topics](#workspace-topics)
- [Commands](#commands)
- [Rendering](#rendering)
- [Security](#security)
- [Web configuration](#web-configuration)
- [Running](#running)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="plugin"></a>
## Plugin

`apply(ctx, config)` declares `inject: ['agents']` only, then mounts the runtime in a child fiber that requires `storageDomain`, `credentials`, and `sessionPersistence`. Everything else is an optional `ctx.get()` read: `attachments` (photos both ways), `commands`, `userQuestions`, `approval` events, `workspaceRegistry` (archiving on `/reset`), and the sandbox policy (which enforces the selected workspace without plugin work).

| Config | Default | Meaning |
|---|---|---|
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Credential reference (env-var name) resolved per operation; the token never appears in config, logs, or the mapping store. |
| `apiBase` | `https://api.telegram.org` | Bot API base URL; tests point it at a local mock server. |
| `allowedChatIds` / `allowedUserIds` | `[]` | Fail-closed allowlists; at least one non-empty side is required at load. Unknown senders are dropped and logged with ids only. |
| `workspaceRoots` | `[]` | Absolute directory roots a topic workspace may select from; non-empty at load. Every selection canonicalizes via `fs.realpath` and must land inside a root. |
| `defaultWorkspace` | — | Workspace used for first-message creation when the topic never ran `/folder`; with exactly one configured root that root is the implicit default. |
| `workspaceTopicsChatId` | — | Forum supergroup where the bot creates one topic per workspace created in this deployment; absent disables the feature. With a non-empty `allowedChatIds` the chat must be listed there, and the composition must mount the workspace registry — both fail load otherwise. |
| `pollTimeoutMs` | `25000` | Long-poll wait, bounded by the Bot API 50-second cap. |
| `queueCap` | `3` | Queued-message cap per topic; beyond it the bot answers busy instead of queueing. |
| `editIntervalMs` | `1000` | Minimum interval between status-placeholder edits for one topic. |
| `approvalTimeoutMs` | `600000` | Unanswered approval/question timeout; settles fail-closed. |
| `agentOptions` | — | Provider/model for created and resumed sessions, mirroring the ACP bridge. |

The plugin fails load on an empty allowlist side set, an empty workspace-root list, and a non-resolving configured root or default workspace.

-----

<a id="topic-session-lifecycle"></a>
## Topic → session lifecycle

Routing key: `chat.id + message_thread_id`; the absent thread id (the General topic, or a private chat) is its own mapping, and posts there omit `message_thread_id` (posting thread id `1` explicitly is rejected by the Bot API).

| Situation | Behavior |
|---|---|
| `forum_topic_created` | Records the topic title as display metadata; creates no session. |
| First message in an unmapped topic | Resolves the workspace (configured default, or a `/folder` hint when several roots allow a choice), creates a session on a deterministic id (`tg-<hash8>-<generation>`), persists the mapping after creation, then follows up. |
| Normal message in a mapped topic | Live session → followup. Cold session → resume from `sessionPersistence` after verifying the stored header `cwd` still canonicalizes to the mapped workspace; a mismatch surfaces a precise error and never replaces the session. |
| Message while the agent is working | The harness queues followups as separate turns; the plugin caps the queue and answers busy beyond `queueCap`. `/cancel` aborts the turn and drops the queue. |
| `/reset` | Disposes the live agent, archives the session in the workspace registry when mounted, writes an audit row, and starts generation `+1` in the same workspace. The old log is never deleted. |
| Topic closed / reopened | `forum_topic_closed` pauses posting to that topic (sends fail with a 400 anyway); `forum_topic_reopened` resumes. Session state is untouched. |
| Plugin or harness restart | Live agents stop with the fiber; the next message resumes the persisted session. A crash between session creation and mapping write is self-healing: the next first message finds the persisted deterministic id and adopts it. |

-----

<a id="workspaces"></a>
## Workspaces

`/folder` without an argument lists the current selection plus the configured roots (never a raw directory listing); `/folder <path>` selects for the next session. Every selection must be absolute, resolve to an existing directory through `fs.realpath`, and land inside a configured root by canonical-path containment (case-insensitive on Windows; no env-var or tilde expansion; UNC only when a UNC root is configured). The harness enforces the same folder as the session's immutable `cwd` and per-call sandbox `workspaceRoot`; a live session keeps its folder, so a `/folder` change takes effect with `/reset`.

-----

<a id="workspace-topics"></a>
## Workspace topics

With `workspaceTopicsChatId` configured, the plugin observes the workspace registry's durable change stream (`domain/changed`) and creates one forum topic per workspace created in this deployment — the web GUI's workspace list drives the Telegram topic list. The topic is named after the workspace title (clamped to Telegram's 128-character bound) and its mapping row is written with `pendingWorkspace` set to the workspace's canonical path, so the topic's first message opens its session in that workspace through the ordinary admission path. Every path still passes the workspace-root fence: a workspace outside `workspaceRoots` gets no topic, a workspace whose path some topic already maps or queues gets no duplicate, and only a creation write (never a rename or session attach) triggers one. The configured chat must be a forum-enabled supergroup where the bot holds the `can_manage_topics` right; a failed Bot API call is logged and creates no mapping row.

-----

<a id="commands"></a>
## Commands

Registered on the harness command runtime (audited as `command/run`/`command/done`): `/status` (session id, workspace, state, queue depth), `/folder [path]`, `/reset`, `/cancel`, `/help`. `/folder` and `/help` also work before a topic has a session.

-----

<a id="rendering"></a>
## Rendering

Committed `assistant/message` text is sent chunked at the Bot API's 4096-character limit with fenced code blocks mapped to `<pre>`; reasoning, raw chunks, and tool blocks stay off the wire. One throttled status placeholder per topic shows tool activity while the agent runs; the first committed answer replaces it, and turn endings become one-line outcomes (errors include the failure code). Inbound photos are stored through `ctx.attachments` and enter the model as image blocks when the configured route declares image input; documents (≤ 20 MB) download into `<workspace>/_telegram_inbox/` and are referenced by path.

-----

<a id="security"></a>
## Security

The token resolves through `ctx.credentials` per operation. Chat and sender are both allowlist-checked before any session work. The workspace-root validation is the read-side fence; the harness sandbox is the write-side fence under the same session cwd. Logs carry ids and outcomes only — never the token or message bodies.

-----

<a id="web-configuration"></a>
## Web configuration

While a settings service is mounted (every shipped profile includes `dsh-settings-file`), the plugin registers the `telegram` settings namespace with its `Config` schema and resolves every operation from the committed section instead of the composition entry. The web GUI's Settings → Plugins → Plugin configuration page renders a Telegram card over that namespace; each save commits a settings-document write that the runtime applies live: the authorization gate rebuilds, the workspace guard re-canonicalizes on the next admission, and pacing, queue, timeout, and token-reference values take effect immediately. `apiBase` applies at the next plugin restart, and `agentOptions` (provider/model) is composition-owned and not editable from the card. Without a settings service the composition entry stays authoritative.

-----

<a id="running"></a>
## Running

The [`dsh-telegram-bundle`](../../bundle/telegram-bundle/README.md) mounts the storage trio, the workspace registry, and this plugin over `dsh-base`; [`examples/telegram-agent`](../../../examples/telegram-agent/README.md) is a runnable standalone composition with a keyless real-Loader smoke.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the topic's agent: Telegram text, photos, and document references enter the transcript as ordinary `user/message` content, and command replies bypass the model entirely.

#### KV Cache effect

Append-only through the session's own user-message history; the plugin contributes no model-visible text of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **`apiBase` and the agent route apply at restart** — the HTTP client and the agent provider/model selection are captured when the plugin starts; the settings card does not expose the latter.
- **Update replay dedupes in memory only** — a crash before offset confirmation replays updates; a bounded in-memory window drops repeats, but a very long outage can redeliver a message as a new turn.
- **Resumed sessions keep the deployment's current composition** — durable mapping state lives in the storage domain; any Telegram-specific model state must be a session-log event, not plugin memory.
- **No `/files` command yet** — the agent names its outputs in text; reading a workspace file back out is deferred.
- **Multi-select questions offer no free-text "Other" answer** — inline buttons collect option sets only.
- **Live agents stay resident until the plugin stops or `/reset`** — resume rebuilds from the persisted log, so an idle-reclaim policy is an optimization, not a correctness requirement.
- **Workspace topics cover live creations only** — the bridge observes the change stream, so a workspace created while the plugin was down gets no topic, and a crash between the Bot API call and the mapping write leaves a topic whose first message falls back to the default workspace.
- **Rate limits** — chunking and edit throttling follow the Bot API flood guidance, but a very long monologue can still reach the per-group send ceiling.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
