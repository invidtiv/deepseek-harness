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
    previous: "2026-10-22-action-card-status"
    after: "e66079027e80dc64a5c5a1556f5ef9d982d37399732fa6c2245927792bb8a4c7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "0c043382c61437f49f4c4510b8368a1999c4aaf0c7d9139b8afc2a967094482a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "d7db2c1630f951674be269d31e49b1af8300bb2a7afe21b4df8163165908a0c2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "47aab872407e07767b58dfa1301e5439bff3155e483e64369a50c798e506845f"
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
