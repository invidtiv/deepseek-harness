---
kind: upgrade-guide
description: "已注册的 ACP 斜杠命令直接执行，不再作为提示词文本发送给模型。"
---

# ACP 斜杠命令

[English](guide.md) | 中文

## 变更

ACP 通过接收 Agent 的命令注册表分发已注册的斜杠命令。此前，所有以斜杠开头的文本都会发送给模型。随附配置包含 `/goal`；其直接结果作为助手文本返回，创建或恢复目标会启动自动工作。命令仅接受文本。普通提示词和未知斜杠命令保持现有行为。

## 迁移

1. 从 v1 `available_commands_update` 通知或 v2 `availableCommands` 设置响应及后续通知读取命令列表。
2. 通过 `session/prompt` 发送 `/goal` 以直接控制目标。确认仅代表命令完成；自动目标轮次可能继续运行。使用 `/goal pause` 或 `session/cancel` 停止目标工作。
3. 要与模型讨论已注册的命令，请将其放在句子中，而不要以该命令开头。移除命令请求中的附件。
4. 验证 `/goal` 返回目标状态或用法，且不启动模型请求。命令发现、生命周期和 v2 重放行为见 [ACP 命令参考](../../../../packages/acp/acp/README.zh.md#slash-commands)。

目标状态现在作为独立助手文本到达，用于自主变化与恢复；命令自身的结果已报告其变更，不会再发送第二条状态消息。请持续处理这些更新，直到会话关闭。新会话的 V1 `available_commands_update` 在 `session/new` 响应之后到达，因此处理它之前应先从响应中读取会话 ID。V1 客户端可使用公布的 `session/load` 回放保留历史；两个版本都会在恢复时收到任务计划更新和当前目标状态。

ACP 现在默认启用 v2 协商。请求版本 2 的客户端须处理 v2 生命周期通知及带稳定 ID 的助手消息分块；如需仅支持 v1 的服务器，须显式设置 `protocolV2: false`。两种握手现在都报告 agent 名称 `deepseek-harness-acp` 与包版本，而不是固定字符串。失败的 v2 轮次报告 `idle`、`stopReason: "error"`，并在 `_meta.error` 中携带失败消息。在 T3 中验证初始化响应报告版本 2。其运行时会等待空闲后才完成 `prompt()`，因此通过该 API 发送下一条提示词前须取消活动的目标工作。
