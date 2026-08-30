# Agent Note: Telegram forum topics are a native per-topic frontend

Status: implemented

[English](2026-08-20-telegram-topic-frontend.md) | 中文

## Problem

Telegram 论坛话题应当各自成为一个持久 Agent 会话并拥有自己的工作目录，无需并行运行时、边车进程或对 Harness 核心的修改。先前的分析（`telegram-topics-analysis.md`，即在本仓库内产出的报告）确认了所有承重原语均已存在且按会话隔离：贯穿每个工具的不可变、已校验的 `SessionHeader.cwd`；基于追加式会话日志的可重启恢复；作为外部传输模板的 ACP 桥（`inject: ['agents']`、followup + `session/event` + `whenIdle`）；持久 domain-KV 存储；以及 workspace registry 的规范化路径校验。问题是 Telegram 前端能否贴合现有扩展点，以及新代码面有多大。

## Decision

Telegram 以一个插件包、一个纯补丁配置包和一个示例叶子交付。本次变更不含任何核心、循环、会话格式或既有配置包的修改。

- **`@deepseek-ai/dsh-telegram`**（`packages/telegram/telegram`）是只声明 `inject: ['agents']` 的函数插件；它在子 fiber 中挂载运行时，强依赖 `storageDomain`、`credentials` 与 `sessionPersistence`（storage-domain 的激活模式），并通过 `ctx.get()` 可选读取 `attachments`、`commands`、`userQuestions`、`workspaceRegistry` 与审批事件。话题→会话映射是插件自己的 storage-domain 单元，名为 `telegram_topics`（存储 `UNIT_NAME_RE` 禁止连字符，因此分析中提议的 `telegram-topics` 不是合法域名），包含一张 `topics` 表与一张供 `/reset` 审计行的 `history` 表。会话 id 具有确定性（`tg-<hash8>-<generation>`），因此会话创建与映射写入之间崩溃时，下一条消息会接管已持久化会话而不是将其遗弃。
- **路由**以 `chat.id + message_thread_id` 为键；缺失的 thread id（General 话题或私聊）自成一条映射，发帖时省略 `message_thread_id`。五个命令（`/status`、`/folder`、`/reset`、`/cancel`、`/help`）注册在 Harness 命令运行时，任何前端都能发现它们，且每次执行都记录 `command/run`/`command/done`。跟进消息依赖 Harness 收件箱队列，并有每话题上限（`queueCap`，默认 3）；超出后机器人回复 busy。
- **工作区**是插件侧的读围栏：每次选择必须为绝对路径、经 `fs.realpath`（workspace registry 的规范）规范化，并通过规范化路径包含检查落在配置根内。Harness 沙箱在同一会话 cwd 下仍是写围栏。恢复时强制 cwd 不可变：持久化 header 的规范化 cwd 与映射工作区不一致时给出精确拒绝，绝不替换会话（即 Web 网关 `SessionCwdConflict` 的立场）。
- **传输**是接口 `TelegramApi` 背后的零依赖 `fetch` 客户端（`HttpTelegramApi`），测试以假实现替换。它实现插件所需的九个端点，每次操作经 `ctx.credentials` 解析令牌，对 429/5xx 做有界重试，全局发送限速，并按 4096 字符上限分块，围栏代码映射为 `<pre>`。助手输出只从已提交的 `assistant/message` 事件渲染；每个话题有一个节流的运行状态占位消息展示工具活动，回合结束变成一行结果。审批与 `ask_user_question` 以 inline-keyboard 按钮呈现；无人应答的提示在 `approvalTimeoutMs` 处按失败关闭处理。
- **`@deepseek-ai/dsh-telegram-bundle`**（`packages/bundle/telegram-bundle`）是 `dsh-base` 之上的纯补丁配置包，插入存储三件套、workspace registry 与 `telegram` 行，其部署值走环境缝隙（`DSH_TELEGRAM_*`），并随附 `telegram` 配置模板（`dsh --profile telegram`）。目录名为 `telegram-bundle`，因为 `packages/bundle/*` 上的 `dsh-*` tsconfig 路径通配符会把 `@deepseek-ai/dsh-telegram` 解析到配置包的 `export {}` 模块。
- **`examples/telegram-agent`** 是可独立运行的示例叶子（沙箱 bash、fs 工具、JSONL 持久化、DeepSeek 适配器与插件），带无密钥真实 Loader 冒烟测试（`tests/keyless-smoke.e2e.ts`）：真实组合对着进程内模拟 Bot API 服务器与脚本化模型启动，让一条话题消息走完整真实 HTTP 客户端，并断言已提交答复到达后才干净退出。

插件还注册了 `telegram` 设置命名空间（以插件 `Config` 作为 section schema 调用 `installSettingsSection`，base 为去掉运行时专属 `transport` 的组合条目），运行时每次操作都从已提交的 section 解析而非组合条目：提交时授权门同步重建，工作区护栏与默认工作区解析在下次准入时惰性失效并重建，限速、队列、超时、令牌引用与 Agent 路由读取都经实时 thunk。Web GUI 的插件 → 插件配置页会为该命名空间渲染一张 Telegram 卡片（随附在 `dsh-client-ui-settings-plugins` 中，与 bash/agent-loop/web-search 卡片并列，十个标量字段，允许列表与根目录用逗号列表转换器）；未挂载该插件的部署中卡片不可见，因为该页取「已服务的命名空间」与「已注册卡片」的交集。`apiBase` 在插件下次重启时生效，`agentOptions` 保持组合层所有。

包测试套件覆盖格式化/分块辅助函数、授权门、工作区护栏（穿越、符号链接、包含）、映射 domain，以及在真实 loop/persistence/storage 服务上的完整测试台：创建、话题隔离、队列上限、命令、reset 代数、重启恢复、确定性接管、cwd 冲突拒绝、经按钮的审批与提问、照片/文档摄取、关闭话题的暂停与恢复、所有注册的清理，以及设置 section（注册、队列上限/允许列表/根目录/默认工作区/审批超时/令牌引用的提交覆盖，加实时读取默认值）。

## Alternatives considered

- **维护中的 Telegram SDK（grammY 或 telegraf）**：被拒——所需线上表面只有九个端点加限速与重试，`fetch` 客户端直接拥有它们；引入依赖不会删掉有意义的自有代码，与 LLM 适配器的裸 fetch 先例一致。若未来进入 webhook 投递、机器人命令元数据同步或支付场景再议。
- **经 `ctx.webServer` 的 webhook 投递**：v1 被拒——长轮询无需主机/绑定假设与 secret-token 处理；Bot API 契约对客户端完全相同。
- **把映射存入会话日志或私有数据库**：被拒——映射是插件拥有的路由状态，不是模型可见的会话历史；storage domain 正是 workspace registry 持久化所用的设施，而 session-persistence 的 SQLite 句柄是后端私有的。
- **按话题拒绝并发消息（ACP 的立场）**：被拒——Harness 收件箱持久且保序，队列带上限即可复用已测机制；ACP 拒绝是因为其线上协议需要一个提示槽位。
- **一张表加 `archived` 标志而非历史表**：被拒——`/reset` 必须保留退休会话 id 供审计，而每话题键一行无法在不用合成键的情况下容纳两代会话；第二张表保持当前映射键不变。

## Consequences

- Harness 核心与既有配置包零改动；部署挂载本包、提供允许列表一侧与工作区根（否则插件加载即报错），机器人即可运行。插件重启/Harness 重启路径就是普通恢复。
- `telegram` 配置模板与配置包依赖进入随附 CLI 表面（`apps/cli`、`PROFILE_TEMPLATES`）。
- 更新重放仅在内存中（有界窗口）去重，因此极长停机可能把一条更新重新投递为新回合；持久化去重需要自己的存储单元，予以推迟。
- 配置现在有两个平面：组合条目（加载期、已校验，含 provider/model 与传输覆盖）与设置 section（实时、由卡片编辑；`apiBase` 仍在重启时生效）。section 的 base 剥离运行时专属 `transport`，因为设置的 describe/schema 解析绝不能携带活对象。
- 向已关闭话题发帖会 400，并暂停该话题直至 `forum_topic_reopened`；没有删除通知，因此休眠话题保留其会话与映射，直至某次发送失败。
- 映射域名在前述分析写作 `telegram-topics` 之处均为 `telegram_topics`（下划线）；决定者是存储单元名模式，而非该分析。
