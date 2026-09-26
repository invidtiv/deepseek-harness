---
description: "Coordinate agents across independently owned Windows and Linux Harness environments, with authenticated peers, durable delivery, and explicit workspace mappings."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-environment-team

English | [中文](README.zh.md)

## Summary

Use this opt-in plugin to create teammates on other Harness installations and share messages and revisioned tasks. Each installation keeps its own credentials, model route, sessions, and checkout. One environment owns each team's coordination; disconnected members retain their assigned tasks. Each machine's ordinary Web UI displays its local Sessions and tool results.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a Web composition with durable Session persistence, storage-domain, the Agent loop, and tools. It coexists with local Agent Teams, but distributed members use `environment_team` and belong to a separate distributed roster. Install this package as a bundle from Plugins, then edit its Environment teams page. Its runtime and operator configuration service are separate entries, so saving runtime settings does not remove the configuration service.

### Configuration

Set `stateDirectory` to a private absolute directory owned by this installation, and set `label`, `provider`, and `model` explicitly. `workspaces` maps project aliases to existing absolute local directories. The lead Session must use one of those directories. A destination uses its own mapping, filesystem, and model route; model credentials are never copied between installations.

Each `peers` entry contains `environmentId`, an HTTPS origin in `url`, the credential reference `tokenEnv`, and allowed project aliases in `workspaces`. Configure both ends in Plugins with their partner's identity and the same independently generated secret of at least 32 bytes. The credential store owns secret values; each operation resolves the current value, so rotation applies without a restart. Use a different secret for every pair. The token grants host-level participation in teams and remote execution within the configured workspace aliases; it is not a per-user or read-only credential. Remote agents retain the destination's composed tools and sandbox policy. Removing a peer and saving the configuration revokes subsequent requests; already-authorized work is not automatically canceled.

Configure `agentPreset`, `sandboxMode`, and `approvalPolicy` explicitly. New members mount that local preset and record those permission settings before publication; they attach to the local Workspace for Web navigation. Resumed members use their persisted preset selection and permissions, with the configured local default model route.

`GET /.well-known/dsh/environment` returns the installation's persisted UUID, label, platform, protocol version, and capability flag. Configure a peer only after obtaining its UUID through a trusted administrative channel. Discovery is public and grants no authority. Every outgoing operation verifies the descriptor before sending the credential, refuses redirects, and verifies the response identity. Literal loopback HTTP is allowed for local integration; other origins require HTTPS. The peer route rejects browser Origin and Fetch-Metadata headers and does not reuse the browser operator cookie.

| Field | Default | Meaning |
|---|---|---|
| `requestTimeoutMs` | `15000` | Deadline for descriptor lookup and one peer operation |
| `retryIntervalMs` | `5000` | Interval between durable outbox retry passes |
| `maxBytes` | `1048576` | Bound for a team record, framed message, HTTP request, or response |
| `maxTeams` | `64` | Maximum coordinator-owned teams |
| `maxMembers` | `16` | Maximum members per team, including the lead |
| `maxTasks` | `256` | Maximum retained tasks per team |
| `maxOperations` | `2048` | Maximum retained mutating-command receipts per team |
| `workspacePageSize` | `100` | Maximum roots, registered workspaces, or directory entries per workspace response |

### Workspace browser

The **Environments** panel lists configured installations by durable identity and preserves unavailable entries. Selecting an installation discovers its registered workspaces and browses its granted directories. Folder creation and workspace registration execute on that destination; an unavailable peer never falls back to the local machine. Failed refreshes retain the loaded view, and responses for a previously selected installation cannot replace the current view.

On the destination, set the calling peer's `workspaceManagement` permission to allow these operations; it defaults to `false`. Its `workspaces` grants limit directory access to configured aliases and their canonical descendants. Traversal and symlinks outside those roots reject. Directory metadata includes destination paths; file contents and credentials are not returned. Repeating folder creation or registering the same directory reuses the existing directory or workspace. `workspacePageSize` truncates lists explicitly, while `maxBytes` bounds the complete encoded response.

Both installations must advertise the workspace browser capability. Remote Sessions still open in the destination's Web app. Registering a nested workspace does not add a team alias; configure that directory as an alias before using it as a distributed team's lead workspace.

### Team operations

`environment_list` lists local identity, workspace aliases, and configured peers without credentials or local paths. `environment_team` supports `list`, `spawn`, `send`, `task-create`, `task-update`, and `interrupt`. Only the lead spawns or interrupts teammates. Members can send to `lead` or another immutable member name and can create or claim shared tasks. Task updates require the observed revision; a competing update rejects. A member cannot change another member's owned task, while the lead can manage ownership through release and claim. Completing a task requires an in-progress task.

A spawn or send result acknowledges durable queueing, not execution or completion. The coordinator retries pending deliveries. The destination deduplicates message acceptance through its Session log, including after restart, and acknowledges only after flushing that log. Retrying the same tool-call identity with the same arguments returns the committed mutation result; changing its arguments rejects. A new tool call is a new command. An interrupted member preserves its pending inbox; interruption is an observed request, not proof that remote execution has stopped.

### Storage and deployment

Keep the identity directory, storage-domain data, and Session persistence together as one installation's state. Do not copy an active installation to create another machine: provision separate state and identity. An exclusive heartbeat lock rejects concurrent ownership of the identity directory. The storage domain also records its environment identity and rejects a different identity on reopen. A malformed identity file fails activation instead of generating a replacement.

For a Tailscale deployment, use one private HTTPS reverse-proxy endpoint per machine and retain DSH's loopback listener. Browser access also requires the ordinary Web trusted-host and authentication configuration. The integration tests exercise real HTTP servers on loopback; deployment through Tailscale Serve and a mixed Linux/Windows fleet requires separate operational verification. No public relay, shared database, or automatic file synchronization is part of this plugin.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The coordinator stores each roster, task list, pending outbox, and command receipts in one validated storage-domain record. A mutation commits its result and retry receipt together. Receiver assignments precede Session creation, so an uncertain response can recover the same destination Session. Message identities include coordinator, team, sender, and operation identity. Incoming messages carry an `environment-team` source with coordinator, team, and sender attribution; they are not direct human input. The receipt projection folds existing inbox events; no additional unlogged model input is introduced. The runtime owns created Agent handles and drains them before releasing its storage and environment lock.

The [protocol](src/protocol.ts) validates wire and persisted records, the [runtime](src/runtime.ts) owns team authorization and state, and the [transport](src/transport.ts) owns bounded authenticated requests. The [identity publisher](src/identity.ts) uses exclusive hard-link publication so concurrent initializers converge on a complete UUID file.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Deployment guide](../../../docs/user/guide/environment-teams.md)
- [Agent Teams](../agent-team/README.md) owns same-process collaboration.
- [Storage-domain](../../storage/storage-domain/README.md) owns durable record updates.
- [Browser connection](../../client/connection/README.md) owns ordinary Web authentication.

-----

<a id="model-experience"></a>
## Model Experience

### Distributed teamwork

#### What the model sees

The two tools return JSON text describing configured environments, team members, queued messages, and revisioned tasks. Delivered messages include the team, coordinator, recipient, and sender followed by the original text and an instruction to use `environment_team`. These messages are ordinary logged user-role input. Generic tool cards display the same results in Web; no remote filesystem path is substituted into the local UI.

#### Token effect

Tool schemas, tool results, and delivered text consume the receiving model's context. Each remote member pays for an independent fresh conversation.

#### KV Cache effect

Messages append to each member's independent history. No conversation prefix or provider cache is shared across machines.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The coordinator must recover before authoritative task updates and member messaging can resume. There is no leader election, failover, automatic reassignment, or session migration.
- Remote members start fresh. They exchange text, commits, or patches; the plugin does not copy conversation history, attachments, repositories, or credentials.
- Peer credentials are configured in Plugins and host-scoped. Automatic pairing invitations, individual browser-session revocation, and per-method read-only grants are not provided.
- The distributed roster and task board appear through tool results. The Environments panel manages workspaces; remote Session tabs, terminals, and the local Agent Teams graphical roster do not project this separate domain.
- Retained teams, tasks, and command receipts have explicit limits. There is no automatic history eviction or team deletion; start a new lead Session when a team's operation budget is exhausted.

<a id="dev-note"></a>
### Dev Note

The [implementation plan](../../../docs/scratch/multi-machine-plan.md) records the intended deployment and acceptance scope. Five isolated loopback environments are an integration fixture, not evidence that five physical machines have been deployed.

**Runtime invariant:** No companion is published. Coordinator records are the authoritative values read by tools and delivery; receiver acceptance is read directly from the Session projection. Lock exclusion, teardown, and cross-host delivery are exercised through Loader and HTTP integration tests rather than an installer that merely checks service presence.
