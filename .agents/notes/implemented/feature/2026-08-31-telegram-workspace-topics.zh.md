# Agent Note：工作区创建驱动 Telegram 论坛话题

状态：已实现

[English](2026-08-31-telegram-workspace-topics.md) | 中文

## 问题

Telegram 前端的话题与会话映射只有一个方向：人在 Telegram 里创建话题，插件创建会话。当 Web GUI 与机器人运行在同一进程中时，Web 创建的工作区无法出现在 Telegram——工作区列表与话题列表逐渐脱节，操作者只能手工把每个工作区重建成话题。

## 决定

新增 `workspaceTopicsChatId` 配置字段指定论坛超级群；缺省即关闭。运行时构造函数拒绝不在非空 `allowedChatIds` 中的群，`start` 在组合未挂载 `ctx.workspaceRegistry` 时拒绝已配置的群——两者都是配置错误，不能静默跳过。

`WorkspaceTopicBridge`（`src/workspace-topics.ts`）监听 `domain/changed`，过滤到 `workspace` 域 `workspaces` 表的 `put`。创建写入以 registry 实体上的 `createdAt === updatedAt` 识别；registry 在表写入之前提交实体缓存，因此事件触发时查询结果是最新的。Bot API 调用前有两道围栏：工作区路径必须通过插件的工作区根围栏（规范路径包含检查），且路径已作为任何映射行的 `workspace` 或 `pendingWorkspace` 存在时不会重复创建。`createForumTopic` 加入 `TelegramApi` 线上接口，新话题的映射行以 `sessionId: null`、generation 1 写入，并把 `pendingWorkspace` 设为工作区的规范路径，于是话题的首条消息经普通准入路径在该工作区打开会话。Bot API 失败只记录 id，不写任何内容。

## 曾考虑的替代方案

- **在 workspace 包上新增专门的 workspace-created 事件**：否决——`domain/changed` 已按写链顺序发布每次持久写入，`WorkspaceFeed` 先例同样从中读取工作区创建；并行事件会造成权威重复。
- **启动时对账，为每个未映射的既有工作区创建话题**：暂不采用——首次启用会用历史工作区的话题淹没论坛；桥接器只覆盖运行期创建，已记为已知限制。
- **启动时以已知 id 集识别创建**：否决——种子与 registry 异步加载竞争时可能把后续变更误判为创建，而 `createdAt === updatedAt` 由写入本身携带。

## 后果

- 在 web app 旁挂载插件的部署（其组合已带 workspace registry）只需一个配置值就把 Web 工作区列表变成 Telegram 话题列表；机器人需要在启用话题的超级群中持有 `can_manage_topics` 权限。
- 插件停机期间创建的工作区不会得到话题；Bot API 调用与映射写入之间崩溃会留下一个首条消息回退到默认工作区的话题；两者均已记入包的已知限制。
- 插件设置卡片不展示该字段；`telegram` 设置 section 提供它，因此组合条目与设置文档编辑都可实时生效。

## 相关

- [Telegram 话题前端 Agent Note](../architecture/2026-08-20-telegram-topic-frontend.zh.md) — 本决定为其话题→会话方向补上反向映射。
