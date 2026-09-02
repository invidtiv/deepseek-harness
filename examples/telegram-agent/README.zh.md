# telegram-agent

[English](README.md) | 中文

一个 Telegram 论坛话题前端组合：每个聊天话题驱动一个持久的编码 Agent 会话，拥有由 Harness 强制的工作目录。普通消息即普通提示；命令只有 `/status`、`/folder`、`/reset`、`/cancel` 与 `/help`。机器人以内联按钮回答审批请求与 `ask_user_question` 提问，并把已提交答复按 Bot API 要求分块渲染。

模型可见工具为 `bash`（沙箱化）、`read`、`write` 与 `edit`，外加自动上下文压缩与 JSONL 会话持久化。沙箱把每个会话的写入限制在其工作区内；插件的工作区根校验负责读侧围栏。

## 运行时环境

| 变量 | 用途 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | 机器人令牌，由凭证服务从环境读取 |
| `DSH_TELEGRAM_ALLOWED_CHATS` | 允许驱动话题的聊天 id，逗号分隔 |
| `DSH_TELEGRAM_ALLOWED_USERS` | 允许驱动话题的用户 id，逗号分隔 |
| `DSH_TELEGRAM_WORKSPACE_ROOTS` | 话题工作区可选绝对根目录，逗号分隔（默认进程 cwd） |
| `DSH_TELEGRAM_DEFAULT_WORKSPACE` | 可选的首条消息创建时默认工作区 |
| `DSH_TELEGRAM_API_BASE` | 可选 Bot API 基础地址（测试指向本地模拟服务器） |
| `DSH_TELEGRAM_PROVIDER` / `DSH_TELEGRAM_MODEL` | 新建会话的 provider/model（默认 DeepSeek 官方路由） |
| `DEEPSEEK_API_KEY` | DeepSeek 适配器凭证 |

在本目录执行 `pnpm dsh --profile telegram-agent` 运行；至少需要一个允许列表侧与一个工作区根，否则插件加载时给出精确错误。

## 无密钥冒烟测试

[`tests/keyless-smoke.e2e.ts`](tests/keyless-smoke.e2e.ts) 通过 Loader 启动真实组合，配以脚本化模型适配器与进程内模拟 Bot API 服务器，让一条话题消息走完整真实 HTTP 客户端，并断言已提交答复到达后进程干净退出。
