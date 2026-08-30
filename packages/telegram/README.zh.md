---
description: "telegram 组地图：以 Telegram 论坛话题驱动逐话题 agent 会话的前端，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/telegram

[English](README.md) | 中文

## 概述

telegram 组把 Telegram 论坛话题变成原生的 harness 前端：每个聊天话题对应一个持久 agent 会话。组内唯一的产品包长轮询 Bot API，把话题中每条经过授权的消息路由到该话题的会话，把已提交的 assistant 输出渲染回话题，并通过内联键盘回答审批请求与提问。部署组合位于别处：[`dsh-telegram-bundle`](../bundle/telegram-bundle/README.zh.md) 在 `dsh-base` 之上挂载该插件，[`examples/telegram-agent`](../../examples/telegram-agent/README.zh.md) 是可直接运行的独立叶子组合。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`telegram`](telegram/README.zh.md) | 把 Telegram 论坛话题作为逐话题会话前端：轮询、路由、渲染、审批 | 函数插件；不注册服务 |

-----

<a id="related-documentation"></a>
## 相关文档

- [`@deepseek-ai/dsh-telegram` README](telegram/README.zh.md) — 话题→会话生命周期、工作区围栏、命令与设置命名空间。
- [Telegram 话题前端 Agent Note](../../.agents/notes/implemented/architecture/2026-08-20-telegram-topic-frontend.zh.md) — 原始设计及其备选方案。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
