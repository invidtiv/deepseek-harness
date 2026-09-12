---
description: "peer harness 家族的包映射：驱动其他 DeepSeek Harness 实例的具名传输注册表、HTTP Remote API 传输，以及面向模型的 peer 工具。"
kind: "package-group"
---

# peer/ — 驱动另一个 harness 实例

[English](README.md) | 中文

## 概述

`peer/` 组让本 harness（智能体框架）能够驱动网络上可达的其他 DeepSeek Harness 实例。[`peer/`](peer/README.zh.md) 是 seam：一个具名的传输注册表，以及每个消费方按 peer 名寻址的操作。[`peer-remote/`](peer-remote/README.zh.md) 是使用浏览器会话 cookie 经 HTTP 调用 peer Remote API 的传输。[`tool-peer/`](tool-peer/README.zh.md) 是把这个 seam 变成 `peer_ask`、`peer_sessions` 与 `peer_transcript` 的面向模型接口面。

peer 在自己的 checkout 中工作，使用自己的模型、工具与会话日志。委派传递的是完整任务，绝不是本 harness 的对话；peer 的 transcript（文本记录）留在 peer 侧。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

以下包提供 peer 家族；完整约定由各包 README 负责。

| 包 | 角色 | ctx key |
|---|---|---|
| [`peer/`](peer/README.zh.md) | 选择已注册的传输，并按名称分派每一项 peer 操作。 | `ctx.peers` |
| [`peer-remote/`](peer-remote/README.zh.md) | 每个插件行对应一个 peer Harness 的 HTTP Remote API 传输。 | — |
| [`tool-peer/`](tool-peer/README.zh.md) | 面向模型的 `peer_ask`、`peer_sessions` 与 `peer_transcript`。 | — |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解操作类型，再看传输所讲的协议，以及它并不替代的进程内委派家族。

- [Peer 子系统](../../docs/subsystems/peer.zh.md)——注册表、传输约定与 peer 操作类型。
- [API 网关](../../docs/api-gateway.zh.md)——peer 传输所讲的 Remote 调用信封与端点归属。
- [Subagent 能力家族](../subagent/README.zh.md)——同一台机器内的进程内与进程外委派，与另一个 Harness 实例相对。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
