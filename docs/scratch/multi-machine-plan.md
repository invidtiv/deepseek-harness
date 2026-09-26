# Multi-machine DSH implementation plan

English | [中文](multi-machine-plan.zh.md)

This work targets five independent DSH Web installations: one Linux host and four Windows hosts connected through Tailscale. Each installation retains its own sessions, credentials, model configuration, and checkout. The first implementation is an opt-in experimental plugin; existing local Agent Teams retain their current behavior.

## Research findings

- `packages/client/connection` owns one browser connection per Context and authenticates requests as one operator. It is not a harness-to-harness authorization protocol.
- `packages/experimental/agent-team/src/roster.ts` authenticates exact local Agent objects; `subagent/src/continuation-activation.ts` creates local Agents. Remote members need explicit ownership rather than pretending to be local continuations.
- `packages/storage/storage-domain` supplies validated durable records and serialized record updates. `agent/inbox/spliced` provides durable acceptance evidence without adding a model-visible side channel.
- `packages/host/webserver` supports effect-owned routes. A separate authenticated peer route can coexist with the browser application without weakening its same-origin checks.
- SSH providers move filesystem and process execution to POSIX hosts while retaining the local Harness. They do not satisfy independent Windows Harness participation.

## Implementation sequence

1. Add durable environment identity and a descriptor. Pin the expected environment on peer calls; validate protocol, endpoint, grants, and configured workspace aliases before execution.
2. Add explicit distributed teams with one coordinator. Persist roster, tasks, idempotent command receipts, and pending messages through storage-domain. Retain retryable work after transport failure.
3. Create independent local Sessions for incoming members. Map a deployment-owned project alias to an absolute local directory. Persist assignment before creation and acknowledge delivery only after the inbox is flushed. Reconcile pending delivery after restart.
4. Expose environment discovery and distributed-team operations as model tools. Remote participants address their coordinator through authenticated peer requests. Local Web views display their ordinary Session transcripts and tool results.
5. Verify identity initialization, authentication denial, mismatched endpoints, permission isolation, idempotent spawn and delivery, revision conflicts, disconnection, restart, and lifecycle disposal. Add a real Loader composition test and recorded model-visible output.
6. Document configuration and the tested deployment path, update bilingual package references, run focused behavior/type/documentation checks, and record remaining platform deployment evidence explicitly.

## Initial protocol limits

One environment owns each team; coordinator failover and automatic task reassignment are excluded. Remote agents start with fresh context. Files are never synchronized implicitly: hosts map project aliases to independent checkouts and exchange commits or patches. Browser aggregation into one multi-environment sidebar is a separate client feature; this iteration keeps DSH Web available on every host.

## Acceptance

A lead can start a member on a paired environment, exchange durable messages, and share revision-checked tasks. Retrying an uncertain command does not create another member or inbox item. Wrong environment identity, missing peer permission, and an unconfigured workspace fail closed. Every model input remains in the destination Session log. Removing a configured grant denies subsequent requests. Disconnect does not imply cancellation or task completion.
