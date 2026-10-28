---
kind: upgrade-guide
description: ACP 客户端必须处理限定范围的批准，以及不含实时用户回显的提示词响应。
---

# ACP 桥接互操作

[English](guide.md) | 中文

## 变更

ACP 桥接需要 `sessionProjections` 来保留权限请求所需的待执行工具参数。内置 ACP 配置已包含此服务。省略该服务的自定义组合无法激活桥接。ACP 包还需要运行时依赖 `@deepseek-ai/dsh-user-questions` 来识别带类型的问题失败；挂载 `userQuestions` 服务仍然可选。

V2 客户端须使用 `session/prompt` 响应的 `messageId` 标识提交的用户消息；桥接不再发送重复的实时用户回显，直接命令也不例外。历史回放仍包含已提交的用户消息。失败的 v2 轮次在结构化空闲错误之前发送可见诊断文本。

## 迁移

1. 在自定义配置补丁中，在 `@deepseek-ai/dsh-acp` 之前以 `session-projection` 为 id 挂载 `@deepseek-ai/dsh-session-projection`。
2. 保持各工具提供者挂载，以提供其注册的 `presentCall` 和 `presentResult` 回调。ACP 使用这些回调生成工具类别、文件位置、差异和命令结果；缺少展示回调时保留通用卡片。
3. 通过 `dsh --profile <name>` 启动配置，确认初始化成功，且工具调用显示其类别和结果。

4. 使用响应 ID 关联提交的提示词，不再等待实时 `user_message`。回放时呈现保留的用户消息，并显示失败轮次的诊断。
5. 按公布的标量 schema 呈现 elicitation 字段。普通回答使用字符串，多选时每行输入一个提供的标签；固定批准和计划审核仅接受公布的枚举选项。工具会话批准仅适用于完全相同的重复调用，并在关闭或策略变更时失效。
