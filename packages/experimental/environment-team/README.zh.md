---
description: "通过经过身份验证的对等连接、持久消息投递和显式工作区映射，在各自拥有状态的 Windows 与 Linux Harness 环境之间协调智能体。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-environment-team

[English](README.md) | 中文

## 概述

这个可选插件可以在其他 Harness 实例上创建队友，并共享消息和带修订号的任务。每个实例保留自己的凭据、模型路由、会话和代码检出目录。每个团队由一个环境负责协调；成员断线不会释放其已分配的任务。每台机器的普通 Web UI 显示本地 Session 和工具结果。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在包含持久 Session 存储、storage-domain、Agent 循环和工具的 Web 组合中挂载此插件。它可以与本地 Agent Teams 共存，但分布式成员使用 `environment_team`，并属于独立的分布式名册。此包是插件，不是独立可执行应用或 profile bundle。

### 配置

将 `stateDirectory` 设为此实例独占的私有绝对目录，并显式指定 `label`、`provider` 和 `model`。`workspaces` 把项目别名映射到已存在的本地绝对目录。负责人 Session 必须使用其中一个目录。目标环境使用自己的映射和模型路由；调用方路径、模型凭据和文件系统内容不会跨越对等协议。

每个 `peers` 项包含 `environmentId`、以 `url` 表示的 HTTPS 来源、环境变量名 `tokenEnv`，以及 `workspaces` 中允许的项目别名。两端分别配置对方身份和同一个独立生成、至少 32 字节的密钥。每一对环境使用不同密钥。此令牌授予主机级团队参与权限，以及在所配置工作区别名内执行远程工作的权限；它不是用户级或只读凭据。远程智能体使用目标环境组合的工具和沙箱策略。移除对等项并重新加载插件后，后续请求会被拒绝；已经授权的工作不会自动取消。

显式配置 `agentPreset`、`sandboxMode` 和 `approvalPolicy`。新成员在发布前挂载该本地预设并记录权限设置，然后关联本地 Workspace 以供 Web 导航。恢复的成员使用持久化的预设选择与权限，以及配置的本地默认模型路由。

`GET /.well-known/dsh/environment` 返回实例持久化的 UUID、标签、平台、协议版本和能力标志。只有通过可信管理渠道获得 UUID 后，才应配置该对等端。发现接口公开可读，但不授予权限。每次出站操作都会先验证描述符，再发送凭据；重定向会被拒绝，响应身份也会被验证。本地集成允许使用字面量环回地址的 HTTP，其他来源必须使用 HTTPS。对等路由拒绝带浏览器 Origin 或 Fetch-Metadata 头的请求，也不复用浏览器操作员 cookie。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `requestTimeoutMs` | `15000` | 描述符查询和一次对等操作的截止时间 |
| `retryIntervalMs` | `5000` | 持久发件箱重试轮次的间隔 |
| `maxBytes` | `1048576` | 团队记录、带框架消息、HTTP 请求或响应的大小上限 |
| `maxTeams` | `64` | 本环境协调的团队数量上限 |
| `maxMembers` | `16` | 每个团队的成员上限，包括负责人 |
| `maxTasks` | `256` | 每个团队保留的任务数量上限 |
| `maxOperations` | `2048` | 每个团队保留的修改命令回执数量上限 |

### 团队操作

`environment_list` 列出本地身份、工作区别名和已配置对等端，不包含凭据或本地路径。`environment_team` 支持 `list`、`spawn`、`send`、`task-create`、`task-update` 和 `interrupt`。只有负责人能创建或中断队友。成员可以向 `lead` 或其他不可变成员名发送消息，也可以创建或认领共享任务。任务更新必须携带已观察到的修订号；冲突更新会被拒绝。成员不能修改另一成员拥有的任务，而负责人可以通过释放和认领管理任务归属。完成任务前，任务必须处于进行中状态。

spawn 或 send 的结果确认的是持久入队，不是执行或完成。协调者重试待投递消息。目标环境根据 Session 日志去重消息接收，重启后仍然有效，并且仅在日志刷盘后确认。使用相同工具调用身份和参数重试，会返回已提交的修改结果；改变参数则会拒绝。新的工具调用是新的命令。中断成员会保留其待处理收件箱；中断结果表示已经观察到请求，不保证远程执行已经停止。

### 存储与部署

将身份目录、storage-domain 数据和 Session 持久存储作为一个实例的状态共同管理。不要复制运行中的实例来创建另一台机器：应配置独立状态和身份。独占心跳锁会拒绝同时占用身份目录的进程。存储域也记录环境身份，并在重新打开时拒绝不同身份。身份文件损坏会使激活失败，而不会生成替代身份。

在 Tailscale 部署中，每台机器使用一个私有 HTTPS 反向代理端点，并保留 DSH 的环回监听。浏览器访问还需要普通 Web 的可信主机和身份验证配置。集成测试使用真实的环回 HTTP 服务器；通过 Tailscale Serve 部署，以及混合 Linux/Windows 机器集群，仍需要单独的运维验证。此插件不包含公共中继、共享数据库或自动文件同步。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

协调者将每个团队的名册、任务列表、待发送消息和命令回执存入同一条经过验证的 storage-domain 记录。修改会同时提交结果和重试回执。接收方先写入成员分配，再创建 Session，因此响应不确定时可以恢复同一目标 Session。消息身份包含协调者、团队、发送者和操作身份。传入消息使用 `environment-team` 来源，记录协调端、团队和发送方归属，不属于直接人类输入。回执投影折叠现有收件箱事件，不引入额外的未记录模型输入。运行时拥有创建的 Agent 句柄，并在释放存储和环境锁之前等待这些智能体停止。

[协议](src/protocol.ts)验证网络与持久记录，[运行时](src/runtime.ts)负责团队授权和状态，[传输层](src/transport.ts)负责有大小限制的身份验证请求。[身份发布器](src/identity.ts)通过独占硬链接发布文件，使并发初始化者收敛到一个完整的 UUID 文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [部署指南](../../../docs/user/guide/environment-teams.zh.md)
- [Agent Teams](../agent-team/README.zh.md)负责同进程协作。
- [Storage-domain](../../storage/storage-domain/README.zh.md)负责持久记录更新。
- [浏览器连接](../../client/connection/README.zh.md)负责普通 Web 身份验证。

-----

<a id="model-experience"></a>
## 模型体验

### 分布式团队协作

#### 模型看到的内容

两个工具返回 JSON 文本，描述已配置环境、团队成员、排队消息和带修订号的任务。投递消息包含团队、协调者、接收者和发送者，然后是原始文本及使用 `environment_team` 的说明。这些消息是普通的、已记录的 user 角色输入。Web 中的通用工具卡片显示相同结果；不会把远程文件系统路径当成本地 UI 路径。

#### Token 影响

工具 schema、工具结果和投递文本占用接收模型的上下文。每个远程成员承担独立新会话的 token 开销。

#### KV Cache 影响

消息追加到每个成员独立的历史中。机器之间不共享会话前缀或提供方缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 协调者必须恢复后，权威任务更新和成员消息才能继续。没有负责人选举、故障转移、自动重新分配或 Session 迁移。
- 远程成员从新上下文开始。成员交换文本、提交或补丁；插件不复制会话历史、附件、仓库或凭据。
- 对等凭据由部署配置，作用域为主机。不提供交互式配对、单个浏览器会话撤销或按方法划分的只读授权。
- 分布式名册和任务板通过工具结果显示。统一多环境侧栏和本地 Agent Teams 图形名册不投影这个独立域。
- 保留的团队、任务和命令回执有显式上限。不自动淘汰历史或删除团队；团队操作预算耗尽后，应创建新的负责人 Session。

<a id="dev-note"></a>
### 开发备注

[实现计划](../../../docs/scratch/multi-machine-plan.zh.md)记录预期部署与验收范围。五个隔离的环回环境是集成测试夹具，不代表已经部署了五台物理机器。

**运行时不变量：** 不发布配套检查器。协调者记录是工具和投递读取的权威值；接收方直接从 Session 投影读取接收证据。锁互斥、清理和跨主机投递通过 Loader 与 HTTP 集成测试验证，而不是由仅检查服务是否存在的安装器验证。
