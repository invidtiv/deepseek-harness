---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-environment-team-attribution

English | [中文](2026-09-26-environment-team-attribution.zh.md)

## Summary

Adds informational environment-team attribution to messages admitted by a distributed team coordinator.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records and Session format remain unchanged. The qualified source kind and its JSON metadata survive readers without the environment-team plugin. Message content and inbox identities remain authoritative for replay and duplicate suppression; unknown-source readers preserve the messages without interpreting coordinator metadata. The source conveys no human or peer authorization.

<a id="verification"></a>
## Verification

The environment-team integration tests read delivered messages with the producer unloaded, retain attribution, and suppress duplicate delivery after receiver restart. Focused package coverage passes all 35 tests at 100%.

<a id="dev-note"></a>
## Dev Note

None.
