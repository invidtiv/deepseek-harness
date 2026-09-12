---
description: "面向模型的 peer 工具，面向让 agent 能够在另一个 DeepSeek Harness 实例上运行任务的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-peer

[English](README.md) | 中文

## 概述

`dsh-tool-peer` 把 peer seam 变成三个面向模型的工具。用 `peer_ask` 在另一个 Harness 上运行完整任务并接收其最终答案，用 `peer_sessions` 查看该 peer 一直在做什么，用 `peer_transcript` 读取某个 peer 会话自己的消息。peer 在自己的 checkout 中工作，使用自己的模型与工具；它只接收任务文本，不接收来自调用方对话的任何其他内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 agent 应当能够到达另一个 Harness 的位置，挂载 seam、至少一个传输与这个消费方。

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

### 这三个工具

| 工具 | 作用 |
|---|---|
| `peer_ask` | 在某个 peer 上运行任务并返回其最终答案。除非 `session_id` 指明某个会话，否则会创建 peer 会话，并阻塞直到该轮次结束。 |
| `peer_sessions` | 列出最近的 peer 会话：id、标题、工作目录、运行状态与最近活动。 |
| `peer_transcript` | 读取某个 peer 会话最近的人类与 assistant 消息，最旧的在前。 |

每个工具都接受一个可选的 `peer` 参数。在只注册了一个 peer 时可以省略；有多个时请指明一个，否则调用会以配置的候选名称失败。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxResultBytes` | `65536` | 一个完整 peer 结果中的最大 UTF-8 字节数。 |

上限作用于摘要行与截断标记之后的完整渲染结果，因此一个过大的 peer 答案不会淹没调用方上下文。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **工具负责呈现，seam 负责传输。** 每个工具都校验自己的参数、调用 `ctx.peers`，并渲染一个有界的面向模型结果。
- **限界作用于完整值。** 缺失的可选字段会被省略，而不是作为 `undefined` 发送，因此声明的输出 schema 对每个结果都成立。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `apply`：三个工具定义、参数投影与有界渲染 |
| — | 不发布运行时不变式伴生入口：本包通过 `ctx.tools` 注册工具，自身不持有可变关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-peer`](../peer/README.zh.md)——这些工具所调用的注册表。
- [`dsh-peer-remote`](../peer-remote/README.zh.md)——这些工具驱动远端 Harness 所需的 HTTP 传输。
- [Subagent 能力家族](../../subagent/README.zh.md)——本机器内的委派；它把子级结果作为一次委派落入调用会话，而不是一次 peer 调用。

<a id="model-experience"></a>
## 模型体验

### Peer 任务结果

#### 模型看到什么

对于每次 `peer_ask`，一个工具结果携带 peer 的最终 assistant 文本；当 peer 结束轮次却没有 assistant 文本时则是一条固定行；其后是括号内的事实行：peer 的结束原因、经过的秒数、peer 上报时的 token 用量，以及 peer 会话 id。`peer_sessions` 为每个会话渲染一行；`peer_transcript` 渲染 peer 自己的用户与 assistant 消息。

#### Token 影响

peer 的答案进入调用会话的历史，并在后续轮次中重新发送，直到压缩（compaction）替换它，并受 `maxResultBytes` 限界。peer 自己的推理、工具调用与中间步骤永远不会进入本会话。

#### KV Cache 影响

在调用会话中是仅追加的：结果沿可复用的请求前缀。peer 自己的请求彼此独立，只复用在其自身组合与历史下相同的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


- **peer 调用会阻塞。** `peer_ask` 会保持调用方工具调用打开，直到 peer 的轮次结束，并受该传输 ask 超时的限界。
- **没有实时 peer 事件。** 这些工具只暴露已结算的结果与已存储的消息；调用方无法逐步观察 peer 的工作。
- **peer 输出是文本。** 这些工具只转发文本，绝不内联来自 peer 的图片、附件或工具负载。
- **结果中没有 peer 身份。** 结果指明它运行所在的会话，而不是回答的那个 peer；注册了多个 peer 时，调用方通过自己传入的参数区分它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
