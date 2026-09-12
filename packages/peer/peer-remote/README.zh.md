---
description: "HTTP Remote API peer 传输，面向把本 harness 指向另一个 Harness 实例的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-peer-remote

[English](README.md) | 中文

## 概述

`dsh-peer-remote` 在 `ctx.peers` 上注册一个 peer Harness 传输。它经 `/api` 讲 peer 的 Remote API，用按请求解析的浏览器会话 cookie 认证每次调用，并把 peer 自己的会话日志变成调用方所要的那个已完成答案。一个插件行就是一个 peer；每个你想驱动的 Harness 注册一行。

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

挂载 seam、为每个 peer 挂载一次本传输，再挂载一个消费方。peer 必须已经运行本机器可达的 web 接口面——例如由 `tailscale serve` 发布到 tailnet 上的 `dsh web`——并且你需要一个与所拨号的确切 authority 相对应的浏览器会话 cookie。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `peerId` | 必填 | 每个消费方与工具参数使用的 peer 名称。 |
| `baseUrl` | 必填 | peer web origin，例如 `https://build-box.tailnet.ts.net:8443`。传输拨号的是其 origin 形式。 |
| `cookieEnv` | `DSH_PEER_COOKIE` | 持有该 peer 浏览器会话 cookie 的凭据引用。 |
| `defaultCwd` | 无 | 请求未指明时使用的 peer 工作目录。 |
| `defaultAgentPreset` | 无 | 请求未指明时使用的 peer agent preset。 |
| `requestTimeoutMs` | `60000` | 一次一元 Remote 调用的边界。 |
| `askTimeoutMs` | `180000` | 等待一个 peer 轮次结束的边界。 |
| `pollIntervalMs` | `2500` | peer 完成轮询两轮之间的延迟。 |

```yaml
- name: '@deepseek-ai/dsh-peer-remote'
  config:
    peerId: build-box
    baseUrl: https://build-box.tailnet.ts.net:8443
    cookieEnv: DSH_PEER_BUILD_COOKIE
    defaultCwd: /srv/work
    defaultAgentPreset: standard
```

### 凭据

cookie 通过 `ctx.credentials` 按 `cookieEnv` 解析，在没有挂载凭据提供方时回退到启动环境。凭据缺失的 peer 会在首次调用时失败，并给出指明该 peer 与引用的消息，而不是匿名拨号。

### 一个任务如何运行

一次 `ask` 会创建 peer 会话（除非请求指明了既有会话），记录该会话的日志游标，接纳提示词，然后轮询该会话，直到在已记录游标之后出现一个轮次结束。结果携带最终 assistant 文本、peer 的结束原因、耗时，以及 peer 上报的任何 token 用量。在 `askTimeoutMs` 内始终不结束轮次的 peer 会失败，并给出指明该 peer 与会话的消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **一行一个 peer。** 插件恰好注册一个传输；扩展到多个 peer 就是多行。
- **Remote 信封即协议。** 每次调用都投递 `{ type, rpcId, method, payload: { args } }`，并在读取值之前校验匹配的 `server-response`。
- **peer 的日志是真源。** 完成是已记录游标之后的一个 `turn/end` 事件，而不是传输层的确认。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、凭据解析、传输注册 |
| [`src/remote.ts`](src/remote.ts) | `RemotePeerTransport`：Remote 调用、会话轮询与协议校验 |
| — | 不发布运行时不变式伴生入口。传输不持有任何持久本地状态；其可观察行为是 peer 响应的函数，并由该传输的边界测试覆盖。 |

### 保留的列表参数

peer 的会话列表调用接受一个保留的请求参数，其协议名称来自 peer Host 自身的方法签名。从源码启动的 Host 会按在线函数命名它，而生成的 Host 可能不同，因此传输会先尝试两种拼写，失败时报告第一次失败。

### 请求策略

携带凭据的请求禁止跟随重定向，因此返回重定向的 peer 无法把 cookie 转发到另一个 origin。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-peer`](../peer/README.zh.md)——本传输注册进的注册表。
- [`tool-peer`](../tool-peer/README.zh.md)——驱动已注册 peer 的面向模型工具。
- [API 网关](../../../docs/api-gateway.zh.md)——这些调用所依赖的 Remote 信封、端点归属与参数校验。

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-peer` 体现；后者渲染 peer 的答案、其结束原因与它运行所在的会话。

#### KV Cache 影响

没有直接影响：传输不会向本 harness 的请求中添加任何内容，消费方自身的结果沿可复用的请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


- **完成靠轮询。** peer 的轮次通过重新读取 peer 的会话列表与日志来检测，因此长时间的轮次会让一次调用在整个持续期间保持打开，调用方无法观察其进度。
- **无法取消 peer 轮次。** 取消本 harness 的调用只会停止本地等待；peer 自己的轮次会继续，直到结束。
- **cookie 与 authority 绑定。** 为一个 origin 签发的 cookie 无法认证另一个 origin，因此经两个地址到达的 peer 需要每个地址一份凭据。
- **仅有结构化协议校验。** peer 负载只按本传输消费的字段读取；peer 版本特定的字段会被忽略，而不是协商。
- **一行一个 peer。** 两次注册同一 `peerId` 会在注册时失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
