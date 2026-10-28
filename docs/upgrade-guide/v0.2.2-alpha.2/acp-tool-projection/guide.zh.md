---
kind: upgrade-guide
description: 自定义 ACP 组合必须提供 Session 投影注册表。
---

# ACP 工具展示依赖

[English](guide.md) | 中文

## 变更

ACP 桥接需要 `sessionProjections` 来保留权限请求所需的待执行工具参数。内置 ACP 配置已包含此服务。省略该服务的自定义组合无法激活桥接。ACP 包还需要运行时依赖 `@deepseek-ai/dsh-user-questions` 来识别带类型的问题失败；挂载 `userQuestions` 服务仍然可选。

## 迁移

1. 在自定义配置补丁中，在 `@deepseek-ai/dsh-acp` 之前以 `session-projection` 为 id 挂载 `@deepseek-ai/dsh-session-projection`。
2. 保持各工具提供者挂载，以提供其注册的 `presentCall` 和 `presentResult` 回调。ACP 使用这些回调生成工具类别、文件位置、差异和命令结果；缺少展示回调时保留通用卡片。
3. 通过 `dsh --profile <name>` 启动配置，确认初始化成功，且工具调用显示其类别和结果。
