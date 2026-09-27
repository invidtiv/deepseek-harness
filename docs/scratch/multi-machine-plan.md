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
6. Package the runtime with a Plugins configuration page. Save arbitrary peer identities and URLs, checkout mappings, worker defaults, and limits through the profile editor; store secrets through the credential service. Keep the coordinator selection per team, determined by the lead Session. Verify saved edits across reload and restart, concurrent-edit rejection, secret rotation, and page lifecycle.
7. Document configuration and the tested deployment path, update bilingual package references, run focused behavior/type/documentation checks, and record remaining platform deployment evidence explicitly.

## Implementation and rollout status

1. Workspace management browses destination directories, creates folders, and registers workspaces under explicit peer grants and canonical path checks.
2. Destination-owned Sessions support creation, listing, live text, cancellation, reconnect refresh, attachments, approval responses, tool details, and terminals. The Remote sessions shortcut and recent-workspace selector preserve scoped drafts, attachment receipts, uncertain submission identities, and the last view in browser memory while switching; returning refreshes from the destination without automatic resubmission. Browser reload clears local drafts.
3. The distributed team dashboard exposes coordinator-owned rosters, revisioned tasks, delivery status, and authorized interruption controls. Remote members remain distinct from local Agent handles.
4. Target machines generate one-time pairing codes with a configurable 30-minute default lifetime. Clients paste the code and choose reciprocal grants; successful acceptance configures both peers automatically. Plugins retains manual configuration and peer removal.
5. The user owns installation on the five physical hosts from the development branch. Real cross-machine team execution, restart recovery, and each host's reachability still require recorded rollout evidence; automated loopback fixtures do not establish physical deployment.

## Initial protocol limits

One environment owns each team; coordinator failover and automatic task reassignment are excluded. Remote agents start with fresh context. Files are never synchronized implicitly: hosts map project aliases to independent checkouts and exchange commits or patches. Each host runs DSH Web; remote workspace and Session navigation uses explicit environment ownership.

## Acceptance

A lead can start a member on a paired environment, exchange durable messages, and share revision-checked tasks. Retrying an uncertain command does not create another member or inbox item. Wrong environment identity, missing peer permission, and an unconfigured workspace fail closed. Every model input remains in the destination Session log. Removing a configured grant denies subsequent requests. Disconnect does not imply cancellation or task completion.

Deployment choices must be editable in Plugins without source edits or deployment environment variables. No hostname, checkout path, machine count, or coordinator is fixed in code.
