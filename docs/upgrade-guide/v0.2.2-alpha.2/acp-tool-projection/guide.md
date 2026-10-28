---
kind: upgrade-guide
description: ACP clients must handle scoped approvals and prompt responses without live user echoes.
---

# ACP bridge interoperability

English | [中文](guide.zh.md)

## Change

The ACP bridge requires `sessionProjections` to retain pending tool-call arguments for permission subjects. Shipped ACP profiles already include this service. Custom compositions that omit it cannot activate the bridge. The ACP package also requires `@deepseek-ai/dsh-user-questions` at runtime for typed question failures; mounting the `userQuestions` service remains optional.

V2 clients must use the `session/prompt` response `messageId` to identify the submitted user message; the bridge no longer sends a duplicate live user echo, including for direct commands. History replay still includes committed user messages. Failed v2 turns emit visible diagnostic text before the structured idle error.

## Migration

1. In the custom profile patch, mount `@deepseek-ai/dsh-session-projection` with id `session-projection` before `@deepseek-ai/dsh-acp`.
2. Keep each tool provider mounted to expose its registered `presentCall` and `presentResult` callbacks. ACP uses these callbacks for tool kinds, file locations, diffs, and command results; missing presenters retain generic cards.
3. Start the profile through `dsh --profile <name>` and verify initialization succeeds and a tool invocation shows its category and result.

4. Correlate submitted prompts using their response IDs rather than waiting for a live `user_message`. Render retained user messages during replay, and display the failed-turn diagnostic.
5. Render elicitation fields from their advertised scalar schema. Ordinary answers use strings, with one offered label per line for multiple selections; fixed approvals and plan review accept only advertised enum choices. Session tool approvals apply to exact repeated invocations and disappear on close or policy changes.
