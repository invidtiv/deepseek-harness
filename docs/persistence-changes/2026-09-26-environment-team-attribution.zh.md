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
    previous: "2026-09-16-session-format-v4"
    after: "ad99d94eeffa485317f794e4c5d12e3ab61e98ad600289c046b7b3fafc9b5e07"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "fe93a4309bbba0a3c584dad579327bed0867b64f46c19433333a1a44b59f29dc"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "09fd23b52e722a7cc782441b6c51f5903ff071b635690b8d2658a26d31e81975"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "b5060ccecf8274beae87e40538895714d0c548ecd31e95281c74a7a702f1c255"
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
