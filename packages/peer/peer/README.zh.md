---
description: "peer Harness seam，面向注册远端 Harness、选择传输或调试 peer 操作的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-peer

[English](README.md) | 中文

## 概述

`dsh-peer` 是驱动其他 DeepSeek Harness 实例的 seam。它提供 `ctx.peers`：一个具名的传输注册表，以及每个消费方按名称寻址的 peer 操作——列出某个 peer 的会话、在某个 peer 上运行任务并等待其轮次结束，以及读取某个 peer 的 transcript（文本记录）。组合中要把本服务与至少一个传输包一起挂载；只挂载服务不会改变任何行为，因为在有传输注册之前没有任何东西能到达 peer。

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

挂载服务、为每个 peer 挂载一个传输，并挂载一个能够到达它的消费方。当前可用的传输列在[进一步探索](#further-exploration)中。

### 注册 peer

```yaml
- name: '@deepseek-ai/dsh-peer'
- name: '@deepseek-ai/dsh-peer-remote'
  config:
    peerId: build-box
    baseUrl: https://build-box.tailnet.ts.net:8443
    cookieEnv: DSH_PEER_BUILD_COOKIE
    defaultCwd: /srv/work
    defaultAgentPreset: standard
- name: '@deepseek-ai/dsh-tool-peer'
```

每个传输行按其配置的 `peerId` 注册一个 peer。两行使用同一名称会在注册时以 `DUPLICATE_PEER` 失败。

### 按名称寻址 peer

每项操作都接受一个可选的 peer 名称。只有在恰好注册了一个传输时才可以省略它：没有传输时，不带名称的操作以 `NO_PEER` 失败；有多个传输时，它以 `AMBIGUOUS_PEER` 失败并列出候选名称。未注册的名称以 `NO_PEER` 失败，而不会回退到另一个 peer。

### 配置

本包没有自己的配置。端点、凭据引用与边界均由各个传输负责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **一个服务，多个传输。** 该服务是一个具名注册表；传输包实现协议并注册自身。
- **选择失败时快速失败。** 缺失或有歧义的 peer 名称会抛出 {@link PeerError}，而不是猜测。
- **受信任的同进程值。** 请求与结果是借用的不可变值；传输在其协议边界负责序列化与恶意输入校验。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PeerService`：注册表、peer 选择与这三项操作 |
| [`src/types.ts`](src/types.ts) | `PeerTransport`、请求/结果词汇与会话摘要 |
| — | 不发布运行时不变式伴生入口：注册表通过 `register`/dispose 修改单个 map，因此探针只会重新执行实现。协议边界行为由传输包与工具包各自负责。 |

### 注册生命周期

`register()` 通过 `ctx.effect` 贡献，因此卸载该传输行只会移除那一个 peer，并让已接受的操作针对它们已经持有的那个传输结算。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`peer-remote`](../peer-remote/README.zh.md)——每个插件行对应一个 peer Harness 的 HTTP Remote API 传输。
- [`tool-peer`](../../peer/tool-peer/README.zh.md)——面向模型的 `peer_ask`、`peer_sessions` 与 `peer_transcript` 工具。
- [Peer 子系统](../../../docs/subsystems/peer.zh.md)——注册表、传输约定与操作类型。
- [API 网关](../../../docs/api-gateway.zh.md)——传输所讲的 Remote 调用信封与端点归属。

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-peer` 体现；后者把每项 peer 操作变成一个结果有界的面向模型工具结果。

#### KV Cache 影响

没有直接影响：注册表不会向请求中添加任何内容，消费方自身的结果沿可复用的请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


- **没有发现机制。** peer 在组合中声明；注册表从不探测网络以寻找可达的 Harness。
- **没有增量观察。** peer 的轮次由传输自身轮询 peer 的会话日志来观察，因此调用方看到的是已结算的结果，而不是实时事件流；除调用工具自身的结果外，peer 的任何内容都不会进入本 harness 的会话日志。
- **传输是受信任的同进程值。** 抛出异常的传输会把异常传播给其调用方；注册表不会把一个 peer 的失败与另一个隔离开。
- **没有实时 peer 句柄。** 该 seam 只暴露缓冲式操作。跨多次调用恢复或引导某个 peer 会话，靠再次指明其会话 id 表达，而不是持有句柄。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
