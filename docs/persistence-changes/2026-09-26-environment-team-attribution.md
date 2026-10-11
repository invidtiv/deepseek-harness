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
## Compatibility

Existing records and Session format remain unchanged. The qualified source kind and its JSON metadata survive readers without the environment-team plugin. Message content and inbox identities remain authoritative for replay and duplicate suppression; unknown-source readers preserve the messages without interpreting coordinator metadata. The source conveys no human or peer authorization.

<a id="verification"></a>
## Verification

The environment-team integration and session-follow projection tests read delivered messages with the producer unloaded, retain attribution, and suppress duplicate delivery after receiver restart. All 47 focused tests pass.

<a id="dev-note"></a>
## Dev Note

None.
