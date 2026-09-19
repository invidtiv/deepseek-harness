# Agent Note: 远程 SSH 工作区与跨客户端会话连续性

Status: proposed

[English](2026-09-18-remote-ssh-workspaces.md) | 中文

## 问题

Harness 把智能体运行时、模型传输和会话存储保留在用户本机，而 [SSH 提供方族](../../../../packages/ssh/README.zh.md) 已用一条部署方拥有的 OpenSSH 别名实现了现有的文件系统、子进程和沙箱接缝。该接缝只能在 `cordis.yml` 中配置，只打开一条不重连的连接，且其 README 因 Web 工作区界面假定可访问本机文件系统而把它限制在 headless 或自定义 profile（[POSIX SSH 决策](../../implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md)）。

[dsh-workspace](../../../../packages/workspace/workspace/README.zh.md) 中的工作区以某个本机目录的 `fs.realpath` 标识，会话成员资格要求其 header 的规范化 `cwd` 等于该路径。身份中没有任何部分指明传输方式、主机或远程目录，因此远程工作区无法被记录、列出、重命名或按远程方式恢复。工作区界面（[`workspace-controller`](../../../../packages/api/workspace-controller/README.zh.md)、[`workspace-files`](../../../../packages/api/workspace-files/README.zh.md)、[目录选择器](../../../../packages/host/directory-picker/README.zh.md)、[`ui-workspace`](../../../../packages/client/ui-workspace/README.zh.md)）直接调用本机文件系统。

会话连续性基本已经建成，并不是缺口所在。会话日志是仅追加且权威的；[`session-controller`](../../../../packages/api/session-controller) 提供 `follow`（开场快照后跟经过间隙校验的实时事件）和 `page`（向后历史与间隙修复）；[客户端 journal](../../../../docs/subsystems/web-client.zh.md) 校验逻辑序列区间，并在每个连接代际的开场快照处替换其窗口；[`client/connection`](../../../../packages/client/connection/src/client/connection.ts) 以退避方式重连。

今天用户无法做到的是：在界面中选择一台 SSH 主机、浏览其目录、在其中创建工作区、对其实施普通工具，并在稍后从第二台 PC 恢复同一个逻辑会话。这项工作要让远程执行及其工作区成为一等且可配置的对象，并让本就正确的事件模型可从第二个客户端抵达。

## 提案

在扩展现有接缝的同时，新增 SSH 环境注册表和远程工作区。不引入第二套 SSH 执行抽象，也不引入 `remote_*` 工具族。

1. **SSH 环境注册表。** 一个 Host 侧 `ctx.sshEnvironments` 服务拥有具名 SSH 环境：显示名、host、port、user、身份/密钥、agent 使用、`~/.ssh/config` 别名、`ProxyJump`、主机密钥策略、连接超时、keepalive 和重连策略。密钥引用现有的 [credentials](../../../../packages/credentials/credentials/README.zh.md) 存储；注册表本身不存储密钥，也绝不未经脱敏上线。
2. **传输无关的工作区身份。** 保留带品牌的 `WorkspaceId`（uuid）作为稳定逻辑身份。新增工作区定位符 `{ transport: 'local' | 'ssh', environment?: SshEnvironmentId, remotePath: string }`。会话 id 仍保持独立，因此多个会话共享一个工作区，一个工作区的存活期长于任何连接。主机名 + 路径绝不作为会话 id。
3. **把 `ctx.ssh` 扩展为连接池。** 现有提供方族契约保持不变；`ctx.ssh` 变为解析器，为每个环境返回一条连接（或用一条共享连接承载每个环境的通道），文件系统、子进程和沙箱提供方从会话定位符解析执行世界。提供方路径描述远程执行世界，绝不被解释为本机路径。
4. **有界的远程目录发现。** 为目录选择器接缝增加 SSH 后端，并让 `workspace-controller` 创建和列出远程工作区。列目录一次只列一层、惰性导航、按大小和条目数设界；文件以流式方式读取而非整体载入。远程文件浏览器复用 `workspace-files`，走同一个文件系统提供方。选择器读取文件系统的 `addressesHostFilesystem` 事实，对报告 `false` 的后端绝不挂载只能返回主机路径的 OS 原生选择器。
5. **复用会话事件模型做同步。** 会话日志仍为权威；客户端继续从 `follow`/`page` 事件派生对话。为 `SessionFollowRequest` 增加客户端连接身份和可选的“从序列恢复”游标，使已持有到 N 号事件的客户端可以请求 N+1 起的内容；开场快照仍是正确性机制，游标只是优化。实时助手输出已通过同一条权威流上的 `agent/assistant-stream` 瞬时帧流动。
6. **支持模式 B。** 让运行时保持可寻址，使第二台 PC 能通过经过认证的连接（隧道，或已经要求 Connection 浏览器会话认证的、刻意对外的非回环绑定）接入同一个会话所有者。这样模式 A（运行时在本地、执行经 SSH 远程）与模式 B（运行时在远端、客户端接入）可以并存；权威所有者始终恰好是一个运行时。

## 工作区与会话身份

工作区记录增加 `transport`，对 SSH 再增加 `SshEnvironmentId` 和远程路径；本地情形保持今天的 `fs.realpath` 规范不变。会话成员资格仍在 attach 时检查，但检查在会话所属的执行世界中运行：对 SSH 工作区，header `cwd` 的规范化通过 SSH 文件系统提供方在远程主机上进行，而不是经由本机 `realpath`。会话 header 同时记录定位符与 `cwd`，使客户端重连后无需从路径拼写猜测即可把会话绑定到正确环境。

## 会话作用域的执行世界

会话的工作区定位符必须选出它所运行的连接，以及文件系统、子进程与沙箱提供方，既不能新增 `remote_*` 工具，也不能给文件系统 seam 增加会话参数。有三项性质约束了该机制。[agent-presets](../../../../packages/preset/agent-presets/README.zh.md) 在同一 standing scope 下为每个预设挂载一份组合，所有指名该预设的会话都会加入它。预设以 `isolate` realm 发布的服务对宿主与该 agent 自身的 scope context 都不可见，而宿主侧「关于某个会话」的请求通过 `serviceForAgent` 读取该实例。它自己的测试固定了推论：各会话是在同一个 standing 实例内部靠插件自身的 Session/Agent 键区分开，而不是靠实例数量。[dsh-scope](../../../../packages/core/scope/README.zh.md) 还把每个键绑定到恰好一个父级，而服务可见性跟随 Cordis 子树，而非 scope 链。

因此执行世界提供方为每个环境持有恰好一条连接，并按每次调用收到的目标进行路由：工作区注册表的定位符（环境加远程路径）决定某个 `resolve`、子进程 `cwd` 或沙箱 `workspaceRoot` 属于哪个世界；不属于任何已知定位符的目标落到部署的默认环境；无法路由的目标明确失败。这样既保持「每预设一份组合」，又让文件系统 seam 不含会话参数，连接的存活期也只有一个所有者。有两条路径被否决。在 agent 与其预设挂载点之间嵌入一个世界 scope 行不通：每个键只绑定一个父级，而服务可见性跟随 Cordis 子树而非 scope 链。为每个工作区各生成一份组合，会按工作区重复整套工具组合。在执行世界提供方按目标路由之前，一份组合后的 [SSH 提供方族](../../../../packages/ssh/README.zh.md) 只服务一个环境，因此多台主机需要各自一个 profile。

## 连接生命周期与重连

SSH 连接拥有连接、keepalive、超时和干净断开。重连是显式且有界的，并且绝不重放结果未知的操作：因传输丢失而中断的变更或启动会显式失败，而不是被重试。会话在 SSH 连接丢失后仍存活，因为会话所有者及其日志位于运行时本地；重连后提供方针对同一远程目录恢复。既有的 [租约与 helper 清理规则](../../implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) 仍是远程清理的所有者。

## 多客户端与会话所有权

多个客户端可以观察同一个会话；恰好一个所有者控制当前智能体回合。客户端通过所有者提交用户输入，并发提交由现有 inbox 串行化，审批绑定到发起会话，因此第二个观察者绝不会替另一个客户端回答审批。断开连接的客户端绝不会终止会话或正在进行的回合，重连的客户端从开场快照获得权威状态。拒绝“最后写入者获胜”的回合语义。

## 凭据与安全

SSH 凭据、口令和密钥材料绝不出现在会话事件、对话消息、模型可见上下文或发送给另一客户端的工作区元数据中。环境注册表只存储凭据引用；取值存放在凭据存储中，任何面向客户端的投影都经过脱敏且只写。主机密钥校验默认严格；密钥变更会拒绝连接。远程沙箱行为不会因工作区在远端而被削弱：read-only、workspace-write 和 danger-full-access 保持既有含义，无法在远端强制的内容（同内核进程限制）会被明确记录，且对安全敏感的失败采用 fail-closed。

## 交付阶段

1. 传输无关的工作区身份与环境注册表——settings 命名空间、在 Web 中编辑它的卡片，以及每条工作区记录携带的定位符——配以身份、配置解析和脱敏的单元测试。
2. `ctx.ssh` 多连接解析与会话范围的提供方选择。
3. 远程工作区选择器、有界目录浏览和远程文件浏览器。
4. 客户端连接身份与从序列恢复，配以重放和并发接入测试。
5. 模式 B 可寻址性、端到端 PC A / PC B 连续性测试，以及用户文档。

## 考虑过的替代方案

**本地镜像目录。** [`dsh-remote-ssh`](https://github.com/cmukanisa/dsh-remote-ssh) 为每个远程目录建立一个空的本机镜像并转换其下的路径。这可以原样复用已发布的工作区注册表，但会引入第二套路径词汇，镜像可能遮蔽同名的本机路径，且在 `ctx.fs` 之外访问文件系统的工具只会看到空目录。如果远程定位符对工作区注册表侵入过大，它是可行的退路，但不是目标方案。

**会话范围的影子工具。** [`dsh-cloud-workspaces`](https://github.com/harryopo/dsh-cloud-workspaces) 在云会话范围内注册远程 `bash`/`read`/`write`/`edit`/`glob`/`grep` 工具。用户需求明确拒绝这第二套工具族；现有能力接缝已随执行世界一并移动 Bash、PTY 和 LSP。

**在 `packages/ssh` 之外新建 SSH 抽象。** 现有提供方族已横跨文件系统、子进程、沙箱、终端、LSP 和 PTC，其传输、摘要校验与 TLS 流认证均有测试。第二套抽象会重复这些工作并分裂执行世界契约。

**只把整个 Harness 迁到远程主机。** 在 [POSIX SSH 决策](../../implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) 中已考虑并拒绝将其作为唯一模型。模式 B 会得到支持，但为本地界面延迟和本地模型传输，模式 A 必须仍然可用。

**为同步另建消息数据库。** 已拒绝。会话日志是权威历史，模型对话由它派生；同步重放事件，而非渲染后的消息。

## 验收标准

- 用户在界面中选择 SSH 环境与远程目录、创建会话后，普通的 `bash`、`read`、`write`、`edit`、`glob`、`grep` 和终端工具在远程主机上操作，无需 `ssh`、`scp` 或任何 `remote_*` 工具。
- 在 `environment:/path` 上打开的会话，在客户端重连后和第二个客户端接入后，仍在该路径上操作。
- 第二台 PC 接入同一会话后获得由事件日志派生的完整历史，其后的事件收敛到同一序列；重连过程中无重复、无缺失。
- 凭据不出现在任何会话事件、消息、模型上下文或客户端可见的工作区元数据中。
- 沙箱模式对远程工作区保持其含义，且已记录无法强制的情形采用 fail-closed。
- 单元测试覆盖工作区身份、SSH 配置解析、attach、序列/重放、去重、重连游标、客户端所有权、并发接入和凭据脱敏。集成测试通过真实的本地或容器化 SSH 服务器驱动文件系统、shell、终端和沙箱。端到端测试针对上述 PC A / PC B 场景断言事件序列。

## 风险

- **SSH 之上的沙箱强度。** 同内核限制（`bwrap`、Seatbelt）无法在远程主机上生效；文件系统围栏会被强制，进程围栏不会。必须在用户选择远程工作区处说明，且对安全敏感操作采用 fail-closed。
- **凭据处理。** 把凭据存储扩展到 SSH 密钥和密码是风险最高的部分；一次脱敏失误就会把密钥泄漏到持久状态或另一客户端。脱敏在 wire 层测试。
- **重连歧义。** 被中断的远程变更结果未知；本设计拒绝重放，可能表现为用户必须重新发起的显式失败。
- **模式 B 的 Web 暴露。** 非回环绑定会暴露运行时；现有浏览器会话认证与 Host/Origin 校验是强制要求，默认姿态保持回环加隧道。
- **范围。** 阶段 1 到 5 体量很大；工作区注册表变更触及身份及每个消费方，因此第一阶段必须先落地并通过评审，再进行选择器工作。

## 相关

- [POSIX SSH 执行提供方](../../implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) —— 本提案所扩展的传输与提供方决策。
- [SSH 子系统](../../../../docs/subsystems/ssh.zh.md) 与 [工作区子系统](../../../../docs/subsystems/workspace.zh.md) —— 各阶段要改动的契约。
- [Web 客户端架构](../../../../docs/subsystems/web-client.zh.md) —— 现有重放与重连语义。
