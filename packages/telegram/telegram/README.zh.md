---
description: "Telegram 论坛话题作为 DeepSeek Harness 原生前端：每个聊天话题一个持久 agent 会话，含路由、渲染、审批与工作区围栏，供部署或调试机器人的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-telegram

[English](README.md) | 中文

## 概述

将 Telegram 论坛话题变为 DeepSeek Harness 的原生前端。每个聊天话题对应一个持久化的 Agent 会话：插件通过长轮询 Bot API 接收更新，把话题中每一条通过授权的消息路由到该话题的会话（创建、恢复，或以精确的错误拒绝），把已提交的助手输出渲染回话题，并用内联键盘按钮回答审批请求与 `ask_user_question` 提问。话题→会话映射是插件自己的 storage-domain 数据单元；会话持久化、工作区隔离、输入排队与取消均由 Harness 承担。

本包是传输适配器，不是能力缝，也不是 UI 集成。它不提供编辑器、转录、模型选择器或终端界面；五个话题命令是普通 Harness 命令，任何其他前端都能发现它们。

## 目录

- [插件](#plugin)
- [话题 → 会话生命周期](#topic-session-lifecycle)
- [工作区](#workspaces)
- [工作区话题](#workspace-topics)
- [命令](#commands)
- [渲染](#rendering)
- [安全](#security)
- [Web 配置](#web-configuration)
- [运行](#running)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="plugin"></a>
## 插件

`apply(ctx, config)` 只声明 `inject: ['agents']`，随后在子 fiber 中挂载运行时，该 fiber 强依赖 `storageDomain`、`credentials` 与 `sessionPersistence`。其余均为可选的 `ctx.get()` 读取：`attachments`（双向图片）、`commands`、`userQuestions`、`approval` 事件、`workspaceRegistry`（`/reset` 时归档），以及沙箱策略（无需插件代码即可约束所选工作区）。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | 凭证引用（环境变量名），每次操作时解析；令牌绝不写入配置、日志或映射存储。 |
| `apiBase` | `https://api.telegram.org` | Bot API 基础地址；测试将其指向本地模拟服务器。 |
| `allowedChatIds` / `allowedUserIds` | `[]` | 失败关闭的允许列表；加载时至少一侧非空。未知发送者被丢弃，日志只记录 id。 |
| `workspaceRoots` | `[]` | 话题可选工作区的绝对目录根；加载时非空。每次选择都经 `fs.realpath` 规范化，且必须落在某个根内。 |
| `defaultWorkspace` | — | 话题从未执行 `/folder` 时，首条消息创建工作区所用值；只配置一个根时该根即隐含默认值。 |
| `workspaceTopicsChatId` | — | 机器人为本部署每个新建工作区创建话题的论坛超级群；缺省即关闭该功能。`allowedChatIds` 非空时必须包含该群，且组合必须挂载 workspace registry——否则加载即报错。 |
| `pollTimeoutMs` | `25000` | 长轮询等待时间，受 Bot API 50 秒上限约束。 |
| `queueCap` | `3` | 每个话题的排队消息上限；超出后机器人回复 busy 而不再排队。 |
| `editIntervalMs` | `1000` | 单个话题状态占位消息的最短编辑间隔。 |
| `approvalTimeoutMs` | `600000` | 无人应答的审批/提问超时；按失败关闭处理。 |
| `agentOptions` | — | 新建与恢复会话的 provider/model，与 ACP 桥一致。 |

允许列表两侧均为空、工作区根为空，以及配置的根或默认工作区无法解析时，插件在加载时即报错。

-----

<a id="topic-session-lifecycle"></a>
## 话题 → 会话生命周期

路由键：`chat.id + message_thread_id`；缺失的 thread id（General 话题或私聊）自成一条映射，发帖时省略 `message_thread_id`（Bot API 会拒绝显式传 thread id `1`）。

| 情形 | 行为 |
|---|---|
| `forum_topic_created` | 仅把话题标题记为展示元数据；不创建会话。 |
| 未映射话题的首条消息 | 解析工作区（配置的默认值，或多个根可选时提示 `/folder`），以确定性 id（`tg-<hash8>-<generation>`）创建会话，创建成功后持久化映射，再跟进消息。 |
| 已映射话题的普通消息 | 会话在线 → 跟进。会话离线 → 校验存储的 header `cwd` 仍规范化等于映射工作区后，从 `sessionPersistence` 恢复；不一致时给出精确错误，绝不替换会话。 |
| Agent 忙碌时来消息 | Harness 把跟进消息排成独立回合；插件限制队列长度，超过 `queueCap` 时回复 busy。`/cancel` 中止回合并清空队列。 |
| `/reset` | 释放在线 Agent，在挂载 workspace registry 时归档会话，写入审计行，并在同一工作区启动 generation `+1`。旧日志永不删除。 |
| 话题关闭 / 重新打开 | `forum_topic_closed` 暂停向该话题发帖（发送本就会 400）；`forum_topic_reopened` 恢复。会话状态不受影响。 |
| 插件或 Harness 重启 | 在线 Agent 随 fiber 停止；下一条消息恢复持久化会话。会话创建与映射写入之间崩溃可自愈：下一条首消息按确定性 id 找到已持久化会话并接管。 |

-----

<a id="workspaces"></a>
## 工作区

不带参数的 `/folder` 列出当前选择与配置的根（绝不做原始目录列举）；`/folder <path>` 为下一个会话选择。每次选择必须为绝对路径、经 `fs.realpath` 解析为已存在目录，并通过规范化路径包含检查落在配置根内（Windows 大小写不敏感；不做环境变量或 `~` 展开；除非显式配置 UNC 根，否则不接受 UNC）。Harness 把同一目录作为会话不可变的 `cwd` 和每次调用的沙箱 `workspaceRoot` 强制执行；在线会话保留其目录，因此 `/folder` 的变更在 `/reset` 后生效。

-----

<a id="workspace-topics"></a>
## 工作区话题

配置 `workspaceTopicsChatId` 后，插件监听 workspace registry 的持久变更流（`domain/changed`），为本部署每个新建工作区创建一个论坛话题——Web GUI 的工作区列表驱动 Telegram 话题列表。话题以工作区标题命名（按 Telegram 的 128 字符上限截断），其映射行写入时把 `pendingWorkspace` 设为工作区的规范路径，于是话题的首条消息经普通准入路径在该工作区中打开会话。每条路径仍要通过工作区根围栏：位于 `workspaceRoots` 之外的工作区不会得到话题，路径已被某个话题映射或排队的工作区不会重复创建，且只有创建写入（重命名或会话挂载都不算）才会触发。配置的群必须是启用话题的超级群，且机器人在其中持有 `can_manage_topics` 权限；Bot API 调用失败只记录日志，不写映射行。

-----

<a id="commands"></a>
## 命令

注册在 Harness 命令运行时（以 `command/run`/`command/done` 审计）：`/status`（会话 id、工作区、状态、队列深度）、`/folder [path]`、`/reset`、`/cancel`、`/help`。话题尚无会话时也支持 `/folder` 与 `/help`。

-----

<a id="rendering"></a>
## 渲染

已提交的 `assistant/message` 文本按 Bot API 的 4096 字符上限分块发送，围栏代码块映射为 `<pre>`；推理、原始 chunk 与工具块不上线。每个话题有一个节流的运行状态占位消息，展示工具活动；第一条已提交答复替换它，回合结束变成一行结果（错误包含失败码）。收到的照片经 `ctx.attachments` 存储，在配置路由声明支持图片输入时以 image 块进入模型；文档（≤ 20 MB）下载到 `<workspace>/_telegram_inbox/` 并按路径引用。

-----

<a id="security"></a>
## 安全

令牌每次操作都通过 `ctx.credentials` 解析。聊天与发送者均先经过允许列表检查才做任何会话工作。工作区根校验是读侧围栏；Harness 沙箱在同一会话 cwd 下构成写侧围栏。日志只含 id 与结果——绝不含令牌或消息正文。

-----

<a id="web-configuration"></a>
## Web 配置

只要挂载了 settings 服务（每个随附 profile 都包含 `dsh-settings-file`），插件就会以自身 `Config` schema 注册 `telegram` 设置命名空间，并让每次操作都从已提交的 section 解析，而不是组合条目。Web GUI 的设置 → 插件 → 插件配置页会为该命名空间渲染一张 Telegram 卡片；每次保存都提交一条设置文档写入，运行时会即时应用：授权门重建、工作区护栏在下一次准入时重新规范化，而限速、队列、超时与令牌引用值立即生效。`apiBase` 在插件下次重启时生效，`agentOptions`（provider/model）属于组合层，卡片不可编辑。没有 settings 服务时组合条目保持权威。

-----

<a id="running"></a>
## 运行

[`dsh-telegram-bundle`](../../bundle/telegram-bundle/README.zh.md) 在 `dsh-base` 之上挂载存储三件套、workspace registry 与本插件；[`examples/telegram-agent`](../../../examples/telegram-agent/README.zh.md) 是可独立运行的组合，并带无密钥真实 Loader 冒烟测试。

-----

<a id="model-experience"></a>
## 模型体验

通过话题的 Agent 间接影响：Telegram 文本、照片与文档引用以普通 `user/message` 内容进入转录，命令回复则完全绕过模型。

#### KV 缓存影响

通过会话自身的用户消息历史仅追加增长；插件本身不贡献任何模型可见文本。

## 已知限制与待完成工作

<a id="known-limitations-and-deferred-work"></a>

- **`apiBase` 与 Agent 路由在重启时生效** — HTTP 客户端与 Agent 的 provider/model 选择在插件启动时捕获；设置卡片不暴露后者。
- **更新重放仅在内存中去重** — 偏移量确认前崩溃会重放更新；有界内存窗口丢弃重复项，但极长停机仍可能把一条消息重新投递为新回合。
- **恢复的会话沿用部署当前组合** — 持久化映射状态位于 storage domain；任何 Telegram 专属的模型状态都必须是会话日志事件，而非插件内存。
- **暂无 `/files` 命令** — Agent 在文本中说明输出文件名；把工作区文件读回发送尚待实现。
- **多选提问不提供自由文本"其他"答案** — 内联按钮只收集选项集合。
- **在线 Agent 常驻直至插件停止或 `/reset`** — 恢复可重建持久化日志，因此闲置回收策略只是优化，不是正确性要求。
- **工作区话题只覆盖运行期创建** — 桥接器监听变更流，插件停机期间创建的工作区不会得到话题；Bot API 调用与映射写入之间崩溃会留下一个首条消息回退到默认工作区的话题。
- **速率限制** — 分块与编辑节流遵循 Bot API 的刷屏指南，但极长的独白仍可能触达群组发送速率上限。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本包不发布运行时不变量伴随模块；该传输层没有持久的包内事件流——话题映射是 storage-domain 数据，由其所属包的不变量校验，路由与生命周期测试覆盖映射关系。

</details>
