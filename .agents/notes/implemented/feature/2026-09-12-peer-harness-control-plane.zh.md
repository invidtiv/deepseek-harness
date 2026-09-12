# Agent Note: Peer Harness 控制平面

Status: implemented

[English](2026-09-12-peer-harness-control-plane.md) | 中文

## 问题

一个 Harness 可以在自己的进程内委派，或委派给同一台机器上的子进程，但没有任何机制让它驱动**另一台机器上的另一个 Harness 实例**。运维方在通过私有网络互联的不同主机上运行多个实例，希望一台主机上的 agent 把完整任务交给另一台主机上的实例、查看那个实例一直在做什么，并读取它得出的结论。Remote API 已经为浏览器 Client 承载了上述每一项操作；当时不存在任何非浏览器消费方，而唯一的凭据流程是浏览器形态的 token 交换。

## 决策

`packages/peer/` 是一个具有三种标准角色的能力 seam。`@deepseek-ai/dsh-peer` 是 Service Definition：`ctx.peers` 是一个具名的传输注册表，加上每个消费方按 peer 名称寻址的操作——`listSessions`、`ask` 与 `transcript`。`@deepseek-ai/dsh-peer-remote` 是传输：一个插件行恰好注册一个 peer Harness，并经 HTTP 讲它的 Remote API。`@deepseek-ai/dsh-tool-peer` 是 Consumer：面向模型的 `peer_ask`、`peer_sessions` 与 `peer_transcript` 工具。

### 它讲的协议

每次调用都向 `<baseUrl>/api/<namespace>/<method>` 投递 `{ type: 'client-request', rpcId, method, payload: { args } }`，并且只接受匹配的 `{ type: 'server-response', rpcId, result }` 信封。失败结果原样携带 peer 自己的错误码与消息。凭据是 peer 的浏览器会话 cookie，以 `cookie` 请求头发送。

### 完成是 peer 日志中的事实

传输读取 peer 的会话列表，记录该会话的日志游标，接纳提示词，然后轮询直到在已记录游标之后出现一个 `turn/end` 事件。结果携带最后一条 `assistant/message` 文本、peer 的结束原因、耗时，以及 peer 上报的任何用量。传输层的确认中不会推断出任何东西。

### 配置与凭据

一个传输行携带 `peerId`、`baseUrl` 与 `cookieEnv` 凭据引用。cookie 通过 `ctx.credentials` 解析，在没有挂载凭据提供方时回退到启动环境。携带该 cookie 的请求禁止跟随重定向，因此 peer 无法把凭据转发到另一个 origin。

### 名称是配置，会话 id 是直通值

peer 名称在组合中编写，行为类似提供方名称；peer 会话 id 是本 Harness 绝不解释的不透明值。二者都不带品牌标记，与本 Harness 自行铸造并解析的身份不同。

### Peer 的工作不进入本会话日志

peer 拥有自己的会话日志、模型路由与工具。跨回来的只有一个已结算的答案，以及调用方显式请求的读取，因此 peer 的推理与工具流量永远不会到达调用会话的 transcript（文本记录）。

## 考虑过的备选方案

**用一个远端提供方扩展 subagent seam。** subagent 提供方约定是用一个已结算结果表示的子级运行；peer 接口面还需要读取 peer *自己的*会话，而这根本不是委派。远端 subagent 提供方仍是合理的后续工作，并且可以复用这个传输。

**通过 ACP 或无头 profile，经 SSH stdio 驱动 peer。** 这不需要监听端口，也不需要存储凭据，但每次调用都会变成一个新的远端进程，每个 peer 都需要一个服务端 profile 与强制命令，而会话列举与 transcript 读取没有对应实现。Remote API 已经存在，并且承载了上述全部能力。

**让控制平面仅限浏览器。** 那么远端接口面仍然由人驱动，任何 agent 都无法调用它。

**把 peer 的 web 接口面绑定到所有网络接口。** `dsh web` 正是拒绝 `--host 0.0.0.0`，因为那会把远程代码执行暴露给网络。本传输不添加自己的监听端口，并假定运维方已经通过私有网络或隧道到达该 peer。

**交付可用的动态 Cordis 插件而不是包。** 动态 Package 是进程本地的，进程重启后就会消失。动态 Package 验证了协议；这个 seam 被做成永久机制。

## 后果

harness 获得了跨越实例的面向模型控制平面：peer 按名称选择，而有歧义或缺失的选择会快速失败，凭据永不进入配置文件，每个结果在到达模型之前都先受限界，并且协议位于一个注册表之后，因此另一个传输可以替换它。

代价是明确的。peer 调用因其完成靠轮询而会在整个轮次期间阻塞；peer 没有实时事件流，也无法取消一个已经接纳的 peer 轮次；cookie 与 authority 绑定，因此经两个地址到达的同一个 peer 需要两份凭据；而传输只校验它消费的字段，不协商 peer 版本。

有一项后果属于运维方而非代码。凭据所授予的权限就是 peer Remote API 所授予的权限。如果一个实例的 API 创建会话拥有完整文件访问且审批已禁用，那么泄露的 cookie 就会变成在该主机上的无人值守执行。本传输不添加监听端口并拒绝重定向，但它无法修复 peer 自身的姿态。

## 测试

注册表选择、effect 作用域内的注册与 dispose（资源释放），以及各 peer 操作均由各包中的单元规格覆盖。传输的协议行为针对一个讲 Remote 信封的真实本地 HTTP 服务器进行覆盖，包括凭据拒绝、非信封响应、peer 错误结果以及保留参数重试。
