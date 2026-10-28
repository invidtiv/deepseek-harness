---
kind: upgrade-guide
description: Custom ACP compositions must provide the Session projection registry.
---

# ACP tool presentation dependencies

English | [中文](guide.zh.md)

## Change

The ACP bridge requires `sessionProjections` to retain pending tool-call arguments for permission subjects. Shipped ACP profiles already include this service. Custom compositions that omit it cannot activate the bridge. The ACP package also requires `@deepseek-ai/dsh-user-questions` at runtime for typed question failures; mounting the `userQuestions` service remains optional.

## Migration

1. In the custom profile patch, mount `@deepseek-ai/dsh-session-projection` with id `session-projection` before `@deepseek-ai/dsh-acp`.
2. Keep each tool provider mounted to expose its registered `presentCall` and `presentResult` callbacks. ACP uses these callbacks for tool kinds, file locations, diffs, and command results; missing presenters retain generic cards.
3. Start the profile through `dsh --profile <name>` and verify initialization succeeds and a tool invocation shows its category and result.
