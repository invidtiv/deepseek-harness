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
    previous: "2026-10-13-user-rpc-principal"
    after: "c834011a4cdbda4f342f2a14029b38cf296c1fbd8922fde8e03df79ba36478c2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "13c2796e04b0a340077628f9481a202965fd8755d9ece118098a9c7d27bae5e1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "db34d2ef2b79d27bf3cb0d3b2f0d7600ab3dd11defd57a8a808e799d202a26c8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "1d9ce0a346cab80af75360121634b1f5407215f72c1a71ae99a3eabe9ce336b3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records and Session format remain unchanged. The qualified source kind and its JSON metadata survive readers without the environment-team plugin. Message content and inbox identities remain authoritative for replay and duplicate suppression; unknown-source readers preserve the messages without interpreting coordinator metadata. The source conveys no human or peer authorization.

<a id="verification"></a>
## Verification

The environment-team integration and session-follow projection tests read delivered messages with the producer unloaded, retain attribution, and suppress duplicate delivery after receiver restart. All 47 focused tests pass.

<a id="dev-note"></a>
## Dev Note

None.
