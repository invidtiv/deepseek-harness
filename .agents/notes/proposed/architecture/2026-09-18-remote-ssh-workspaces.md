# Agent Note: Remote SSH workspaces and cross-client session continuity

Status: proposed

English | [中文](2026-09-18-remote-ssh-workspaces.zh.md)

## Problem

The Harness keeps the agent runtime, model transport and Session storage on the user's machine, and the [SSH provider family](../../../../packages/ssh/README.md) already implements the existing filesystem, subprocess and sandbox seams against one deployment-owned OpenSSH alias. That seam is configured only in `cordis.yml`, opens one non-reconnecting connection, and its README limits it to headless or custom profiles because the Web workspace UIs assume host filesystem access ([POSIX SSH decision](../../implemented/architecture/2026-09-11-posix-ssh-runtime.md)).

A workspace in [dsh-workspace](../../../../packages/workspace/workspace/README.md) is identified by the `fs.realpath` of a host directory, and Session membership requires a header whose canonical `cwd` equals that path. No part of the identity names a transport, a host, or a remote directory, so a remote workspace cannot be recorded, listed, renamed, or resumed as one. The workspace UIs ([`workspace-controller`](../../../../packages/api/workspace-controller/README.md), [`workspace-files`](../../../../packages/api/workspace-files/README.md), the [directory pickers](../../../../packages/host/directory-picker/README.md), [`ui-workspace`](../../../../packages/client/ui-workspace/README.md)) call the local filesystem directly.

Session continuity is already largely built and is not the gap. The Session log is append-only and canonical; [`session-controller`](../../../../packages/api/session-controller) exposes `follow` (an opening snapshot followed by gap-validated live events) and `page` (backward history and gap repair); the [Client journal](../../../../docs/subsystems/web-client.md) validates logical sequence ranges and replaces its window from every connection generation's opening snapshot; and [`client/connection`](../../../../packages/client/connection/src/client/connection.ts) reconnects with backoff.

What a user cannot do today is choose an SSH host in the UI, browse its directories, create a workspace there, run the ordinary tools against it, and later resume that same logical session from a second PC. The work is to make remote execution and its workspace first-class and configurable, and to make the already-correct event model reachable from a second client.

## Proposal

Add an SSH environment registry and remote workspaces while extending the existing seams. No second SSH execution abstraction and no `remote_*` tool family are introduced.

1. **SSH environment registry.** A host-side `ctx.sshEnvironments` service owns named SSH environments: display name, host, port, user, identity/key, agent use, `~/.ssh/config` alias, `ProxyJump`, host-key policy, connect timeout, keepalive, and reconnect policy. Secrets reference the existing [credentials](../../../../packages/credentials/credentials/README.md) store; the registry itself stores no secret and is never placed on the wire unredacted.
2. **Transport-neutral workspace identity.** Keep the branded `WorkspaceId` (a uuid) as the stable logical identity. Add a workspace locator `{ transport: 'local' | 'ssh', environment?: SshEnvironmentId, remotePath: string }`. The Session id remains separate, so several Sessions share one workspace and one workspace outlives any connection. Hostname + path is never the session id.
3. **Extend `ctx.ssh` to a connection pool.** The current provider family contract is preserved; `ctx.ssh` becomes a resolver that returns one connection per environment (or one shared connection with per-environment channels), and the filesystem, subprocess and sandbox providers resolve the execution world from the Session's locator. Provider paths describe the remote execution world and are never interpreted as host paths.
4. **Bounded remote directory discovery.** Give the directory-picker seam an SSH backend and let `workspace-controller` create and list remote workspaces. Listings are one level at a time, lazily navigated, size- and entry-bounded; files are streamed rather than loaded whole. The remote file explorer reuses `workspace-files` over the same filesystem provider. The chooser reads the filesystem's `addressesHostFilesystem` fact and never mounts an OS-native chooser — which can only return a host path — for a backend that reports `false`.
5. **Reuse the Session event model for synchronization.** The Session log stays canonical; clients continue to derive the conversation from `follow`/`page` events. Add a client-connection identity and an optional resume-from-sequence cursor to `SessionFollowRequest` so a client that already holds events through N can request N+1 onward; the opening snapshot stays the correctness mechanism and the cursor is an optimization. Live assistant output already flows through `agent/assistant-stream` as transient frames over the same authoritative stream.
6. **Mode B support.** Keep the runtime addressable so a second PC can attach to the same session owner over an authenticated connection (a tunnel, or a deliberate non-loopback bind that already requires Connection's browser-session authentication). Mode A (runtime local, execution remote over SSH) and Mode B (runtime remote, clients attach) then coexist; the authoritative owner is always exactly one runtime.

## Workspace and session identity

The workspace record gains a `transport` and, for SSH, an `SshEnvironmentId` plus a remote path; the local case keeps today's `fs.realpath` canon unchanged. Session membership continues to be checked at attach time, but the check runs in the workspace's own execution world: for an SSH workspace, canonicalization of the header `cwd` happens on the remote host through the SSH filesystem provider, not through the host's `realpath`. A Session header records the locator as well as the `cwd`, so a client can bind the Session to the correct environment after reconnect without guessing from the path spelling.

## Session-scoped execution worlds

A Session's workspace locator must select the connection and the filesystem, subprocess and sandbox providers it runs in, without a new `remote_*` tool and without a session argument on the filesystem seam. Three properties bound the mechanism. [agent-presets](../../../../packages/preset/agent-presets/README.md) mounts one composition per preset under a standing scope that every Session naming that preset joins. A service a preset publishes behind an `isolate` realm is invisible to the host and to the agent's own scope context, and a host-side request that is about a Session reads that instance through `serviceForAgent`. Its own suite fixes the consequence: sessions stay apart inside one standing instance by the plugin's own Session/Agent keying, not by instance count. [dsh-scope](../../../../packages/core/scope/README.md) additionally binds one key to exactly one parent, while service visibility follows the Cordis subtree rather than the scope chain.

The world provider therefore owns one connection per environment and routes each call by the target it receives: the workspace registry's locator — environment plus remote path — decides which world a `resolve`, a subprocess `cwd`, or a sandbox `workspaceRoot` belongs to, a target under no known locator falls to the deployment's default environment, and an unroutable target fails visibly. That keeps one composition per preset, keeps the filesystem seam free of a session argument, and leaves connection lifetime with a single owner. Two alternatives are rejected. Nesting a world scope between an agent and its preset's mount cannot work, because a key binds to one parent and service visibility follows the Cordis subtree rather than the scope chain. Generating one composition per workspace duplicates a preset's whole tool composition for every workspace. Until a world provider routes targets this way, one composed [SSH provider family](../../../../packages/ssh/README.md) serves one environment, so several hosts need one profile each.

## Connection lifecycle and reconnect

The SSH connection owns connect, keepalive, timeout, and clean disconnect. Reconnect is explicit and bounded, and it never replays an operation whose outcome is unknown: a mutation or launch interrupted by transport loss fails visibly rather than being retried. Sessions survive a lost SSH connection because the session owner and its log are local to the runtime; on reconnection the providers resume against the same remote directories. The [existing lease and helper-cleanup rules](../../implemented/architecture/2026-09-11-posix-ssh-runtime.md) remain the remote-cleanup owner.

## Multi-client and session ownership

Many clients may observe one Session; exactly one owner controls the active agent turn. Clients submit user input through the owner, concurrent submissions are serialized by the existing inbox, and approvals are tied to the requesting Session so a second observer never answers another client's approval. A disconnected client never terminates the Session or a running turn, and a reconnecting client receives the authoritative state from the opening snapshot. Last-writer-wins on agent turns is rejected.

## Credentials and security

SSH credentials, passphrases, and key material never appear in Session events, conversation messages, model-visible context, or workspace metadata sent to another client. The environment registry stores credential references only; the values live in the credentials store, and any client-facing projection is redacted and write-only. Host-key verification defaults to strict; a changed key refuses the connection. Remote sandbox behaviour is preserved rather than weakened because the workspace is remote: read-only, workspace-write and danger-full-access keep their existing meanings, and what cannot be enforced remotely (same-kernel process confinement) is documented and fails closed for security-sensitive failures.

## Delivery phases

1. Transport-neutral workspace identity and the environment registry, with unit tests for identity, config parsing, and redaction.
2. `ctx.ssh` multi-connection resolution and Session-scoped provider selection.
3. Remote workspace picker, bounded directory browsing, and remote file explorer.
4. Client connection identity and resume-from-sequence, with replay and concurrent-attach tests.
5. Mode B reachability and end-to-end PC A / PC B continuity tests, plus user documentation.

## Alternatives considered

**Local mirror directories.** [`dsh-remote-ssh`](https://github.com/cmukanisa/dsh-remote-ssh) gives every remote directory an empty local mirror and translates paths under it. This reuses the shipped workspace registry unchanged, but it introduces a second path vocabulary, mirrors can shadow same-named local paths, and tools that reach the filesystem outside `ctx.fs` see an empty directory. It is a viable fallback if a remote locator proves too invasive for the workspace registry, not the target.

**Session-scoped shadow tools.** [`dsh-cloud-workspaces`](https://github.com/harryopo/dsh-cloud-workspaces) registers remote `bash`/`read`/`write`/`edit`/`glob`/`grep` tools in a cloud Session's scope. The user requirement explicitly rejects this second tool family; the existing capability seams already move Bash, PTY and LSP with the execution world.

**A new SSH abstraction beside `packages/ssh`.** The existing family already spans filesystem, subprocess, sandbox, terminals, LSP and PTC, and its transport, digest verification and TLS stream authentication are tested. A second abstraction would duplicate that and split the execution-world contract.

**Move the whole Harness to the remote host only.** Considered and rejected as the only model in the [POSIX SSH decision](../../implemented/architecture/2026-09-11-posix-ssh-runtime.md). Mode B is supported, but Mode A must remain available for local UI latency and local model transport.

**A second message database for synchronization.** Rejected. The Session log is the canonical history and the model conversation is derived from it; synchronization replays events, not rendered messages.

## Acceptance criteria

- A user selects an SSH environment and a remote directory in the workspace picker, creates a Session, and the ordinary `bash`, `read`, `write`, `edit`, `glob`, `grep` and terminal tools operate on the remote host with no `ssh`, `scp`, or `remote_*` tool.
- A Session opened on `environment:/path` continues to operate on that path after a client reconnect and after a second client attaches.
- A second PC attaching to the same Session receives the complete history derived from the event log, and subsequent events converge on the same sequence; nothing is duplicated or missing across reconnect.
- Credentials appear in no Session event, message, model context, or client-visible workspace metadata.
- The sandbox modes keep their meanings for remote workspaces, and the documented unenforceable cases fail closed.
- Unit tests cover workspace identity, SSH config parsing, attachment, sequence/replay, deduplication, reconnect cursors, client ownership, concurrent attach and credential redaction. Integration tests drive filesystem, shell, terminal and sandbox over a real local or containerized SSH server. End-to-end tests assert event sequences for the PC A / PC B scenario above.

## Risks

- **Sandbox strength over SSH.** Same-kernel confinement (`bwrap`, Seatbelt) cannot apply on the remote host; the filesystem fence is enforced, the process fence is not. This must be stated where a user chooses a remote workspace and must fail closed for security-sensitive operations.
- **Credential handling.** Extending credential storage to SSH keys and passwords is the highest-risk area; a redaction mistake leaks secrets into durable state or another client. Redaction is tested at the wire.
- **Reconnect ambiguity.** An interrupted remote mutation has an unknown outcome; the design refuses to replay it, which can surface as a visible failure the user must re-issue.
- **Web exposure for Mode B.** A non-loopback bind exposes the runtime; the existing browser-session authentication and Host/Origin checks are mandatory, and the default posture stays loopback plus tunnel.
- **Scope.** Phases 1 through 5 are large; the workspace-registry change touches identity and every consumer, so the first phase must land and be reviewed before the picker work.

## Related

- [POSIX SSH execution providers](../../implemented/architecture/2026-09-11-posix-ssh-runtime.md) — the transport and provider decision this proposal extends.
- [SSH subsystem](../../../../docs/subsystems/ssh.md) and [Workspaces subsystem](../../../../docs/subsystems/workspace.md) — the contracts the phases change.
- [Web Client architecture](../../../../docs/subsystems/web-client.md) — the existing replay and reconnect semantics.
