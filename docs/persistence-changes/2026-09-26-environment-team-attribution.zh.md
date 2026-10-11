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
    previous: "2026-10-05-working-directory-attribution"
    after: "c604bac26672deea53a6eeff7c19d5292001f865c5bca9d794638eede940faf4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "b0e816dd625b9264e5257db0ab8cc223e194053f757ed851de65d4790bc92887"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "16ae762957c18b0e40e0eda3f0f13b3daf3d400dd0aa0ee6df65b82096c48b15"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "3d46896ed1c15eb94c3ef68a4e8d219202780d2579d572f8e49a73fff075f91f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录和 Session 格式保持不变。限定的来源种类及其 JSON 元数据可由未加载 environment-team 插件的读取方保留。消息内容与收件箱身份仍负责回放和重复抑制；未知来源的读取方保留消息，无需解释协调端元数据。此来源不授予人类或对等端权限。

<a id="verification"></a>
## 验证

environment-team 集成测试与 session-follow 投影测试在卸载生产方后读取已投递消息、保留来源归属，并在接收方重启后抑制重复投递。47 个聚焦测试全部通过。

<a id="dev-note"></a>
## 开发备注

无。
