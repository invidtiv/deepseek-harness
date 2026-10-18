---
kind: upgrade-guide
description: "Registered ACP slash commands execute directly instead of reaching the model as prompt text."
---

# ACP slash commands

English | [中文](guide.zh.md)

## Change

ACP dispatches registered slash commands through the receiving Agent's command registry. Previously all slash-prefixed text reached the model. The shipped profile includes `/goal`; its direct results return as assistant text, and creating or resuming a goal starts automatic work. Commands accept text only. Ordinary prompts and unknown slash commands retain their existing behavior.

## Migration

1. Read the command list from v1 `available_commands_update` notifications or v2 `availableCommands` setup responses and subsequent notifications.
2. Send `/goal` through `session/prompt` for direct goal control. Treat its acknowledgement as command completion; automatic goal rounds can continue afterward. Use `/goal pause` or `session/cancel` to stop goal work.
3. To discuss a registered command with the model, embed it within a sentence instead of beginning the prompt with that command. Remove attachments from command requests.
4. Verify `/goal` returns goal status or usage without starting a model request. See the [ACP command reference](../../../../packages/acp/acp/README.md#slash-commands) for discovery, lifecycle, and v2 replay behavior.

Goal status now arrives independently as assistant text for autonomous changes and restoration; a command's own result reports its mutation without a second status message. Handle these updates until the session closes. V1 `available_commands_update` for a new session follows the `session/new` response, so read the session ID from the response before handling it. V1 clients may use advertised `session/load` to replay retained history; both versions receive task-plan updates and current goal state on restoration.

ACP now enables v2 negotiation by default. Clients requesting version 2 must handle v2 lifecycle notifications and assistant message chunks with stable IDs; set `protocolV2: false` explicitly to retain a v1-only server. Both handshakes now report the agent name `deepseek-harness-acp` and the package version instead of fixed strings. A failed v2 turn reports `idle` with `stopReason: "error"` and the failure message in `_meta.error`. Verify the initialize response reports version 2 in T3. Its runtime waits for idle before resolving `prompt()`, so cancel active goal work before sending another prompt through that API.
