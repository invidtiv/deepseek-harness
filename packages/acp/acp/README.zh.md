---
description: "面向程序化客户端与维护者的仅自动化 ACP（Agent Client Protocol）服务器，用于通过 JSON-RPC stdio 驱动 DeepSeek Harness agent（智能体）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-acp

[English](README.md) | 中文

## 概述

`dsh-acp` 让受信任客户端通过标准 [ACP](https://agentclientprotocol.com) 驱动持久化 DeepSeek Harness agent：创建、恢复或 fork 会话，选择模型与计划模式，运行工具，审阅权限并回答问题。客户端接收文件差异、命令结果、标题与草案 v2 实时 shell 输出。它适合编辑器集成、进程外 subagent 与脚本控制器。运行 `pnpm dsh --profile acp` 启动服务器；仓库客户端为 `dsh-subagent-acp`。

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

当脚本、测试运行器或另一个 harness 需要通过标准自动化协议端到端运行 agent 工作时，使用本包。常用路径是：启动服务器、创建或恢复会话、按需挂载 MCP 服务器并选择模型选项、发送提示词、消费语义更新，再关闭会话。

### 何时选择

当 ACP 客户端负责交互并渲染标准工具卡片与问题时使用它。服务器提供 ACP v1 与协商的草案 ACP v2；DSH 专用 Web 组件与持久终端控制不属于此接口。

### 最小配置

服务器创建的每个会话都使用此处配置的提供方与模型。两个字段都是可选的，以便由另一个 agent/request 监听器提供；可运行的演示组合会同时设置两者。Stdout 只承载协议流量，因此请让日志远离它。

```yaml
- name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | — | 每个会话 agent 的提供方路由 |
| `model` | — | 每个会话 agent 的模型 |
| `sessionListPageSize` | `100` | 单页 `session/list` 返回的最大摘要数量 |
| `protocolV2` | `true` | 协商草案 v2，同时保留稳定 v1 |
| `sessionReplayPageSize` | `256` | 转录回放每页读取的最大持久事件数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-acp)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 启动服务器

`pnpm dsh --profile acp` 启动随附 stdio 服务器，同时挂载会话持久化与必需的 Session 投影注册表。客户端可以列出、恢复、fork 和关闭持久会话。[`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.zh.md) 启动同一 profile 以执行进程外委派。

> **警告——完全访问部署：** 设置 `sandbox-policy.config.mode: danger-full-access` 会移除 Harness 对本地命令和文件工具的文件系统隔离；宿主账户的权限仍然适用。`approval.config.policy: never` 会禁用审批提示并拒绝请求审批的操作，而不是自动批准这些操作。仅对受信任的 ACP 客户端和工作负载使用这些设置。

显式 ACP 部署覆盖层可以设置这两项策略，无需依赖启动器的环境：

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()

- id: approval
  config:
    policy: never
```

在 T3 Code 的环境变量值字段中设置 `DSH_PERMISSION_MODE` 时，输入 `danger-full-access`，不要包含字面的引号字符。包含 `'danger-full-access'` 这些字符的值会导致 sandbox-policy 校验失败，并可能使依赖它的 shell 和文件工具不可用；客户端的完全访问标签不能验证 Harness 插件是否激活。修改环境或覆盖层后，重启 ACP 提供方。恢复的会话保留其已记录的权限策略；在依赖此次变更之前，验证会话的有效设置和原生工具可用性。

<a id="protocol-contract"></a><a id="standard-acp-v1-surface"></a>
### 协议约定

一个连接可以同时运行多个会话，彼此独立。下表描述 v1：

| 调用 | 你会得到什么 |
|---|---|
| `initialize` | 稳定 ACP v1、会话生命周期与 Streamable HTTP MCP 支持；兼容附件存储启用图片传输，不依赖初始模型。 |
| `authenticate` | 立即成功；服务器不需要身份验证。 |
| `session/new` | 全新持久 agent；其绝对工作区与 stdio 或 HTTP MCP 服务器会在发布前通过校验，并返回完整配置选项状态；命令列表在响应之后发送。 |
| `session/list` | 按确定的新到旧顺序分页返回已持久化、可恢复的根会话；可选绝对 `cwd` 筛选会尽可能使用物理目录标识。 |
| `session/load` | 恢复非活跃的持久会话，并在返回前回放保留的对话消息、工具和任务计划；返回前针对该会话的请求都会失败，之后的事件排在回放之后。 |
| `session/resume` | 恢复一个已持久化且非活跃的会话；组合前校验其规范工作区，并恢复日志但不回放旧更新。 |
| `session/close` | 停稳式取消、更新 drain、后代释放、持久化 flush，并且只释放指定 Agent 作用域。 |
| `session/set_config_option` | 更新已公布的模型、推理强度或已组装的 `collaboration_mode` 选择，并返回完整结果状态。 |
| `session/prompt` | 有序文本、资源链接与受支持图片，每个会话一次一个提示词；根 Agent 与后代完成且有序更新交付后才结算。 |
| `session/cancel` / `$/cancel_request` | 提示词所拥有的取消路径；没有进行中的 ACP 提示词时取消自主工作，未知会话 id 则为空操作。 |
| `session/update` | 按会话串行交付已提交消息、工具呈现、配置、用量与 `session_info_update` 标题。 |
| `session/request_permission` | 带一次性允许／拒绝选项的权限提示；你的客户端可以自动回答。 |

`session/fork` 从已提交的源快照创建独立持久 Agent，继承记录中的模型与计划选择，同时挂载新的 MCP 连接。活跃源会话必须空闲，且没有正在进行的提示词、命令或权限交换。子会话不继承运行中的进程或待处理输入。列表与恢复允许普通 fork，包括带 `parentSession` 的历史日志；仍排除 `origin: subagent`。

受管理后代运行期间、它们的结果触发根 Agent 后续轮次期间，以及已提交输出仍在交付期间，提示词保持进行中。输出交付期间接受的根 Agent 工作会加入同一活动区间，并在该区间完成后结算。最终结果包含最新根轮次的停止原因与所有助手输出交付错误；只有原始提示词轮次固定使用接受时捕获的模型选择。取消会停止调用时已有的根 Agent 活动，并等待该活动及其已排队输出完成。之后到达的子 Agent 消息可以启动自主工作，但不会延迟取消响应；会话仍可接受后续提示词。收件箱消息处于停放状态的空闲后代继续驻留，但不延迟提示词完成。关闭会话还会释放其后代。

即使前一轮已经完成，追加 `turn/start` 或 `turn/end` 失败仍会使提示词请求失败。

会话配置从实时 LLM 目录提供按提供方分组的模型与推理强度选项。模型变更从下一个模型步骤生效；已准备的步骤和重试保留已捕获的选择。每个图片提示词在存储附件前校验当前模型，因此切换到视觉模型无需新建连接。切换到纯文本模型后，后续图片提交会明确失败。MCP 声明授权其命令、环境、URL 与 header；初始连接或发现失败会回滚尚未发布的 Agent。

### 工具呈现与人工决策

已注册工具的呈现器提供标准工具名、种类、绝对位置、文件差异与 shell 退出状态。权限请求复用该呈现和原始输入，让客户端应用操作策略。未知工具保留 `other` 与原始参数。权限只提供一次性允许／拒绝选项；批准一条命令不会授权该工具之后的所有调用。

组装计划模式时，`collaboration_mode` 选择器提供 `plan` 与 `build`。轮次进行中发生的变更从下一次已接纳步骤开始生效。此选择改变计划指导，不改变沙箱权限。`exit_plan_mode` 通过一次性权限审阅展示计划；批准后由计划服务退出计划模式。

协商表单 elicitation 的客户端可通过 `elicitation/create` 回答人工问题，包括多选和可选自定义文本。当问题和工具服务可用时，桥接层会在已协商的会话中挂载 `ask_user_question`，并保留已有工具注册。固定审批问题只接受已提供的选项。计划审阅使用权限通道。宿主问题期限会取消待处理交换；迟到答案被忽略，不支持的客户端不会收到未公布的表单请求。

草案 v2 通过 `tool_call_content_chunk` 流式传输保留的 shell 作业输出。传输背压期间，每个作业只保留一个待发送的有界环形缓冲快照；数据缺口会明确报告，不会静默拼接。最终工具结果以权威内容替换预览。V1、没有作业服务的部署，以及 `promoteOnTimeout: false` 的前台 shell 路径仅在完成时交付输出。

<a id="slash-commands"></a>

### 斜杠命令

在 `session/prompt` 中以文本发送已注册的斜杠命令，例如 `/goal finish the task`、`/goal`、`/goal edit revised objective`、`/goal pause`、`/goal resume` 或 `/goal clear`。桥接层直接执行接收 Agent 的命令注册表；命令输入和输出不进入模型历史。随附配置包含目标服务与自动轮次驱动器，因此创建或恢复目标会启动工作。命令仅接受文本；附带图片或资源链接会在执行前被拒绝。未识别的斜杠命令仍作为普通模型提示词处理。

V1 通过 `available_commands_update` 公布完整命令列表：在 `session/new` 响应之后、在 `session/load` 或 `session/resume` 响应之前发送，因此客户端总是先知道会话 ID；v2 在这些响应中返回 `availableCommands`。注册表变更会替换列表。命令结果使用标准助手文本更新。V1 在命令结果交付后返回 `end_turn`，不等待自动目标轮次。V2 使用仅在实时连接中有效的用户消息 ID 回显命令并返回该 ID；该回显及其直接结果不会重放。命令注册表持久化自身生命周期事件，目标服务持久化已接受的变更。

命令可以在前台提示词或自动轮次执行期间查看、暂停或编辑目标。每个会话同时只接受一个命令，命令执行期间拒绝普通提示词。自动轮次独立于命令确认发布 v2 活动状态。`session/cancel` 通过现有取消路径停止正在执行的目标工作，并中止正在运行的命令，该命令随后像被取消的提示词一样结算：v1 返回 `cancelled`，v2 拒绝该请求且不回显；关闭会话会先取消并排空命令，再释放 Agent。没有命令注册表的自定义组装不会公布命令。

### 目标状态与任务计划

目标变更、激活状态变化和已接纳轮次通过标准助手文本发布目标内容、阶段、续行资格、轮次数及阻塞原因。加载或恢复会发布当前目标状态，但不会启用已恢复目标的自动续行；使用 `/goal resume` 显式重启自动工作。这些状态消息仅用于传输输出，不进入模型历史。命令自身的结果已报告其所做的变更；该命令不会再重复一条状态文本，状态文本只覆盖自主变化与恢复。

持久化的 `todo/write` 列表映射为完整 ACP 计划：v1 使用 `plan` 更新，v2 使用会话内 ID 为 `todos` 的 `plan_update` 条目列表。由于 DSH 任务没有优先级字段，所有优先级均为 `medium`。新轮次清空之前的列表；恢复会重建当前列表，历史加载则回放其替换记录。计划模式与计划文档预览仍独立于任务列表进度。

### 草案 ACP v2

ACP 默认启用 v2 协商；仅在只部署 v1 时设置 `protocolV2: false`。请求 `protocolVersion: 2` 的客户端将获得 v2。此连接使用 v2 的 `info` 与 `capabilities`；v1 客户端保留原有握手与提示词生命周期。两种握手都报告 agent 名称 `deepseek-harness-acp` 与本包的版本。固定的 SDK `1.7.0` 提供独立的 v1 与实验性 v2 校验器和处理程序。不公布身份验证方法。

配置档补丁会替换目标行的整个 `config`。当 ACP 负责初始模型选择时，须在 `protocolV2` 旁同时填写 `provider` 和 `model`；仅包含开关的覆盖层会移除该选择。

v2 提示词在其轮次将消息提交到对话后返回规范 Harness 用户 `messageId`，无需等待模型完成；排在其他工作之后的提示词尚未被接受，在提交前被取消或移除的提示词会让请求失败且不回显。服务器回显已提交的用户消息，然后发送 `running`。权限交换报告 `requires_action`，所有未完成回答到达后恢复 `running`。完成时报告 `idle` 与停止原因，包括 `cancelled` 或 `error`；失败的轮次还会在 `_meta.error` 中携带失败消息，而不是作为转录文本。`$/cancel_request` 可在提交前取消提示词；接受后使用 `session/cancel`。每个会话仍只允许一个前台提示词。

已提交的 assistant 文本与 thought 使用带稳定 ID 的消息分块；工具调用使用 `tool_call_update` upsert。用户与 assistant ID 保留 Harness 标识；thought ID 在 assistant ID 后添加确定性的 `:thought` 后缀。模型选择器使用 `configId` 与 `groupId`。恢复会发布已恢复的目标状态与现行计划，然后发布当前空闲状态；`replayFrom: { type: "start" }` 会先通过分页存储读取回放保留的用户编写消息、assistant 消息、工具事实与计划替换。实时交付与回放回显相同的已提交用户编写消息；注入的模型上下文不会成为用户回显。

[v2 迁移指南](https://agentclientprotocol.com/protocol/v2/migration)与[基础 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.json)定义草案协议格式。显示终端与附加工作区根目录没有 ACP 投影；v2 协商不意味着支持这些功能。[T3 互操作测试](../../../apps/cli/tests/profiles/acp/tests/t3-interop.e2e.ts) 使用 `DSH_T3_CODE_ROOT` 指定的检出目录运行通用 ACP runtime；未配置时会跳过。T3 的 `prompt()` 等待 idle，因此发送另一个提示词前须取消运行中的目标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务器如何实现上述行为，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

服务器是刻意采用标准公开协议的自动化传输。三项承诺塑造了它：

- **标准语义更新。** 已注册工具的呈现器提供种类、位置、差异、命令退出状态和权限对象；未知工具保留通用卡片。临时作业输出仅为预览，已提交结果仍是权威数据。
- **诚实的能力与配置状态。** `initialize` 只公布已挂载支持，拓扑变化会发布完整配置选项，模型选项变更从下一个模型步骤开始生效。
- **停稳后才完成。** V1 提示词结果、v2 终态与关闭响应等待所属工作和有序输出排空；v2 提示词接受不等待完成。

决策历史记录在 [ACP 作为仅面向自动化的协议笔记](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md) 与[多会话笔记](../../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md) 中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、协议路由与握手、按会话记录、监听器接线、清理 |
| [`src/session.ts`](src/session.ts) | 单个会话的 Agent、命令、提示词准入与结算、有序更新、回放与进度 |
| [`src/content.ts`](src/content.ts) | 协议内容准入与投影：图片校验、路由重查、提示词重建、assistant 块转换 |
| [`src/output.ts`](src/output.ts) | 与协议无关的更新交付及其稳定 v1 实现 |
| [`src/updates.ts`](src/updates.ts) | 已提交会话事件的标准 v1 投影，用于实时交付与历史回放 |
| [`src/codec.ts`](src/codec.ts) | 轮次结束到 ACP `stopReason` 的纯映射 |
| [`src/tool-projection.ts`](src/tool-projection.ts) | 已注册工具呈现与权限对象 |
| [`src/job-output.ts`](src/job-output.ts) | 实时作业输出的有界独立观察 |
| [`src/questions.ts`](src/questions.ts) | 表单 schema、答案校验与取消 |
| [`src/v2.ts`](src/v2.ts) | 草案 v2 内容、配置、已提交事件投影与更新交付 |

### 准入与提示词结算

每个会话只允许一个正在处理的提示词。准入先校验整个提示词批次、快照所选路由、重新检查 Agent 是否为同一对象与图片能力、持久化图片附件，然后才把用户消息入队——先于准入完成的取消绝不会让迟到的轮次入队。Agent 拥有模型选择；每个已准备步骤捕获其提供方、模型与推理强度，后续步骤则读取已接受的选项变更。按会话更新会串行交付；已提交图片会重新读取并验证完整性，因此 assistant 输出或工具结果中的图片缺失或损坏会让前台提示词失败，而不是发出占位符。两种协议都会记录传输写入失败，并交由连接清理处理。结算优先级依次为显式取消、已提交输出失败、区间内 Agent 失败、关联轮次结束。

### 清理与连接归属

每个会话模块拥有其 Agent 句柄、MCP 挂载、模型配置、提示词槽位、更新链和记忆化关闭操作。显式关闭、客户端断开与 Cordis 释放使用同一停稳式清理流程：停止新工作、取消提示词准入与 Agent 活动、drain 已提交更新、按子优先顺序释放可继续后代、flush 持久化并释放所拥有的 Agent 作用域。会话关闭后，已持久化的状态仍可供列出与恢复；共享上下文的其他会话或前端不受影响。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从匹配的客户端逐步进入自动化约定背后的设计记录。

- [dsh-subagent-acp](../../subagent/subagent-acp/README.zh.md)——spawn 并驱动本服务器的进程外 ACP 客户端。
- [ACP 作为仅面向自动化的协议](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md)——自动化约定及其协议边界的决策记录。
- [在单个连接上多路复用并发 ACP 会话](../../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md)——按会话隔离、归属与清理决策。
- [扩展实操手册](../../../docs/cookbook/extension-cookbook.zh.md)——本包作为扩展作者的仅自动化完整示例。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词内容

#### 模型看到什么

`session/prompt` 会在一条用户消息中保留文本与图片顺序：相邻文本会拼接，资源链接则表示为带方括号的 `[resource_link name=… uri=…]` 引用，模型可以使用自身工具打开它。内联图片 base64 在批量准入后即被丢弃，因此持久消息只包含经过校验的附件引用。协议元数据、客户端能力、权限选择与会话 id 绝不进入模型请求。

#### Token 影响

提示词内容、工具调用／结果和持久图片引用会保留在该会话中直到上下文压缩（context compaction）。所选计划模式将计划服务的指导加入模型请求。人工答案进入所属工具结果；实时输出预览不增加模型 token。并发会话保留独立上下文。

#### KV Cache 影响

只要所选路由与组装后的前缀保持不变，就仅追加。模型变更会使下一个 ACP 轮次改用新路由。

### 权限决策

#### 模型看到什么

不会直接看到任何内容。所属工具通过常规工具结果路径记录其结果：允许、拒绝、取消或不可用。

#### Token 影响

只有所属工具的结果会贡献 token。

#### KV Cache 影响

仅通过所属工具的结果追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是协议对比或任务积压。

- **仅一个主 workspace**——附加目录仍不支持。
- **仅光栅提示词图片**——PNG、JPEG、WebP 与 GIF 要求持久附件存储及确切的图片能力路由。
- **仅 MCP 工具**——MCP resource 与 prompt 没有 DSH 消费方。
- **不支持的协议操作**——不投影会话删除、附加根目录、SSE 或 ACP 传输 MCP、持久终端控制、客户端文件系统操作和 URL elicitation。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
