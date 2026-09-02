---
description: "The telegram group map: the Telegram forum-topic frontend that drives per-topic agent sessions, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/telegram

English | [中文](README.zh.md)

## Summary

The telegram group turns Telegram forum topics into a native harness frontend: one durable agent session per chat topic. Its single product package long-polls the Bot API, routes every authorized message in a topic to that topic's session, renders committed assistant output back into the topic, and answers approval requests and questions through inline keyboards. Deployment composition lives elsewhere: [`dsh-telegram-bundle`](../bundle/telegram-bundle/README.md) mounts the plugin over `dsh-base`, and [`examples/telegram-agent`](../../examples/telegram-agent/README.md) is a runnable standalone leaf.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`telegram`](telegram/README.md) | Telegram forum topics as a per-topic session frontend: polling, routing, rendering, approvals | function plugin; registers no service |

-----

<a id="related-documentation"></a>
## Related documentation

- [`@deepseek-ai/dsh-telegram` README](telegram/README.md) — the topic→session lifecycle, workspace fence, commands, and settings namespace.
- [Telegram topic frontend Agent Note](../../.agents/notes/implemented/architecture/2026-08-20-telegram-topic-frontend.md) — the original design and its alternatives.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
