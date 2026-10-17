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
