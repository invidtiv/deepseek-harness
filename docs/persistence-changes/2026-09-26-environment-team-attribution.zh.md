---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-environment-team-attribution

[English](2026-09-26-environment-team-attribution.md) | 中文

## 概述

为分布式团队协调端接纳的消息添加信息性的 environment-team 来源归属。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-environment-team-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "ae171dfe8377a2c24c34fe35e740a802b867c286a3a6ef5acb64b1ae9e0c90b2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "e5544078869437d76803043c4af58a7c28b42974f70f31681f2adbc32ecf0be5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "da0b393c135750aa4ec31f20c49f969b78318756bcda50830984da8b9acf30e5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "20c059492f81b9fd68d3ec1683968b48e95c2619381d03d8ac26036274d3432b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录和 Session 格式保持不变。限定的来源种类及其 JSON 元数据可由未加载 environment-team 插件的读取方保留。消息内容与收件箱身份仍负责回放和重复抑制；未知来源的读取方保留消息，无需解释协调端元数据。此来源不授予人类或对等端权限。

<a id="verification"></a>
## 验证

environment-team 集成测试在卸载生产方后读取已投递消息、保留来源归属，并在接收方重启后抑制重复投递。聚焦包覆盖率检查中，35 个测试全部通过，覆盖率为 100%。

<a id="dev-note"></a>
## 开发备注

无。
