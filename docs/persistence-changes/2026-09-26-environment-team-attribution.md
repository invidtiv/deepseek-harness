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
## Compatibility

Existing records and Session format remain unchanged. The qualified source kind and its JSON metadata survive readers without the environment-team plugin. Message content and inbox identities remain authoritative for replay and duplicate suppression; unknown-source readers preserve the messages without interpreting coordinator metadata. The source conveys no human or peer authorization.

<a id="verification"></a>
## Verification

The environment-team integration tests read delivered messages with the producer unloaded, retain attribution, and suppress duplicate delivery after receiver restart. Focused package coverage passes all 35 tests at 100%.

<a id="dev-note"></a>
## Dev Note

None.
