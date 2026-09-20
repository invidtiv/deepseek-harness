---
description: "OpenSSH connection configuration and remote helper lifecycle for deployments composing POSIX file, process and sandbox providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh

English | [中文](README.zh.md)

## Summary

`dsh-ssh` connects a Harness host — Linux, macOS, or Windows — to an installed helper on a POSIX SSH host. One deployment-owned OpenSSH alias supplies authentication and host identity; the paired filesystem, subprocess and sandbox providers use that connection. The connection verifies installed artifact digests before readiness; the helper owns remote cleanup when the connection closes or its lease expires.

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

Compose this service with [`fs-ssh`](../fs-ssh/README.md), [`subprocess-ssh`](../subprocess-ssh/README.md) and [`sandbox-ssh`](../sandbox-ssh/README.md) in a custom `dsh` profile. The host runs the Harness, model transport and Session storage; the remote machine supplies the files and processes. Headless profiles support this arrangement.

### Deployment prerequisites

The remote helper host requires Linux or macOS. A Linux or macOS Harness host reaches it through OpenSSH control-master multiplexing and Unix-socket forwarding, so its `ssh` command must support both and the server must permit the forwarding; a Windows Harness host has neither, so each stream opens a dedicated loopback `ssh -L` session instead. Configure the alias, credentials and known-host entry before startup: the service enables `BatchMode`, checks host keys (strictly by default), disables agent forwarding and adds no interactive authentication flow.

Install the built helper and its matching runtime dependencies on the remote host. Keep Node, helper, bootstrap and their dependencies outside the workspace and writable temporary roots. They must also remain outside a backend’s replaced temporary tree, such as bwrap’s private `/tmp`; the workspace may still be under `/tmp`. Digest verification detects an unexpected installed artifact after helper startup; it does not make writable deployment files safe to execute or authenticate a malicious SSH host.

| Field | Default | Meaning |
|---|---|---|
| `host` | one of `host`/`environment` | OpenSSH destination: a config-file alias, a host name, or an address |
| `environment` | one of `host`/`environment` | Named environment resolved through the `ssh-environments` settings registry |
| `node`, `helper` | required | Absolute remote Node executable and bundled helper entry |
| `workspace` | `/` | Absolute remote default workspace; absent opens the directory picker at the remote root |
| `helperHash` | required | Lowercase SHA-256 of the installed helper entry |
| `bootstrapPath`, `bootstrapHash` | omitted | Paired remote PTC entry and its lowercase SHA-256 |
| `requestTimeoutMs` | `30000` | Connection and administrative-request deadline, from 1 through 2,147,483,647 ms |
| `maxFrameBytes` | `67108864` | Per-message JSON payload ceiling, at most 64 MiB |
| `maxPending` | `128` | Ordinary outstanding requests; heartbeat and bounded cleanup requests have reserved capacity |
| `leaseMs` | `30000` | Helper heartbeat lease, from 3000 to 600000 ms |
| `port` | omitted | Explicit OpenSSH TCP port; omitted keeps the config file's value |
| `user` | omitted | Explicit login user; omitted keeps the config file's value |
| `identityFile` | omitted | Private-key path passed as `-i`; `~` is accepted |
| `identityAgent` | omitted | Agent socket passed as `IdentityAgent`; omitted uses `SSH_AUTH_SOCK` |
| `proxyJump` | omitted | `ProxyJump` destination for a bastion chain |
| `configFile` | omitted | Alternate OpenSSH config file passed as `-F` |
| `hostKeyChecking` | `yes` | `yes` refuses an unknown or changed key; `accept-new` trusts an unknown key once; `no` accepts either |
| `connectTimeoutMs` | omitted | `ConnectTimeout` in milliseconds; omitted keeps the OpenSSH default |
| `serverAliveIntervalMs` | `10000` | `ServerAliveInterval` in milliseconds |
| `serverAliveCountMax` | `3` | `ServerAliveCountMax` probe count |

Provide exactly one of `host` and `environment`: `environment` names an entry in the `ssh-environments` settings registry. A named environment is resolved while the connection is constructed, so the settings provider and the `dsh-ssh-environments` row must already be composed; an unavailable registry fails the connection instead of falling back to another destination.

For PTC, configure both bootstrap fields and pass the verified `ctx.ssh.nodeExecutable` and `ctx.ssh.bootstrapPath` to [`NodePtcRuntime`](../../ptc-runtime/ptc-runtime-node/README.md). Basic filesystem and Bash use may omit the pair. The `bootstrapPath` getter refuses an unconfigured PTC deployment.

### Routing between environments

One `ssh` row serves one world. A deployment that reaches several servers composes the pool row (`@deepseek-ai/dsh-ssh/worlds`) beside one `ssh` row per environment, each carrying its own `environment` or `host`; every row registers its connection with the pool while the pool is composed, and the row the Loader does not isolate serves the deployment default. Routing is by target: the workspace registry's locators — environment plus remote directory — decide which world a path belongs to, the longest owning locator wins, a target no locator claims belongs to the default connection, and two worlds that claim one directory are refused. A target whose world has no composed connection fails visibly.

Every provider routes through the pool: the filesystem sends each operation — including each continuation of an opened text stream — to the connection that owns its target, the subprocess provider spawns a process or terminal on the connection that owns its `cwd`, and the sandbox provider confines on the connection that owns the policy's workspace root. The two lookups that carry no target, executable resolution and the terminal environment, refuse to answer while named worlds are composed.

### Lazy connections from the settings registry

Composing `@deepseek-ai/dsh-ssh/broker` instead of one `ssh` row per environment opens connections from the `ssh-environments` registry on demand. `ctx.sshBroker.list()` returns the environments that declare every required runtime coordinate — `node`, `helper` and `helperHash` — and `ctx.sshBroker.connect(id)` composes that environment's connection on first use in its own `ssh` realm, exactly as one isolated `ssh` row would, then reuses it until the broker unloads. Every connection registers itself with the pool while `@deepseek-ai/dsh-ssh/worlds` is composed, so the providers route to it by workspace exactly as they route to a composed row.

A connection that fails to start is discarded, so the next `connect` tries again; a connection that drops after startup is never reconnected. Unloading the broker disposes every connection it opened and joins their remote cleanup.

`ctx.sshBroker.listDirectory(id, path?)` and `ctx.sshBroker.createDirectory(id, path, name, policy)` serve the in-app directory picker: they resolve and list one remote level, or create one child directory, through that environment's connection, so an operator can browse and choose a remote project before any workspace exists. Both carry the remote host's own POSIX spelling; the picker's browse backend reads this service by name.

### A local execution world beside the SSH providers

`@deepseek-ai/dsh-ssh/local-world` composes the local filesystem, subprocess and sandbox providers in their own service realms and publishes them as `localFs`, `localSubprocess` and `localSandbox`. Compose it when the SSH providers are the deployment's `ctx.fs`, `ctx.subprocess` and `ctx.sandbox` and must serve host paths as well: each then delegates a target no SSH world claims to that local world, so one process serves local and remote workspaces together. The local-only provider rows are disabled in such a composition, because two rows may not register one execution seam.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The OpenSSH master carries private administrative RPC. Each program stream uses a separate forwarded socket and an independent SSH channel; a Windows host, which has no control master, opens a dedicated loopback session per stream. Program stdout cannot forge administrative replies or occupy the control stream’s channel window. SSH transport congestion still affects the shared connection.

Each stream reservation has a random 256-bit TLS pre-shared key carried only by administrative RPC. TLS authenticates both endpoints and protects every stream byte; the key is never sent as a stream preface. Socket directories are private (`0700`) and sockets use `0600`. Replacing a writable socket path cannot impersonate an endpoint or reveal the stream key; an attacker can still interrupt service or relay opaque TLS records.

Connection disposal joins forwarding and cancellation subprocesses and partially established streams before removing local resources. Transport loss rejects pending operations and invalidates the connection. The helper starts managed cleanup on SSH EOF, termination signals or heartbeat expiry. A disconnected client cannot confirm the remote outcome; operations are never reconnected or replayed automatically.

Failed startup and process results release their reservations after native quiescence; the bounded completion cache preserves the original rejection for later result reads. Helper shutdown also joins endpoint and directory cleanup already in progress.

For terminals opting into shell activity observation, root exit retains the reservation and its remaining work. Activity RPC continues to reach the provider; explicit termination awaits quiescence before releasing endpoints and recording the completed result. Helper connection disposal and lease expiry retain their existing termination authority.

The helper starts with `--disable-sigusr1`, so a same-user process signal cannot open its Node debugger.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — execution coordinates, transport semantics and lifecycle ownership.
- [POSIX SSH decision](../../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) — rationale, alternatives and required verification.
- [Windows client transport](../../../.agents/notes/implemented/architecture/2026-09-19-windows-ssh-client-transport.md) — why Windows needs a loopback OpenSSH session per stream.

-----

<a id="model-experience"></a>
## Model Experience

None, as host aliases, authentication and stream capabilities are private deployment details and consumers own every model-visible operation.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No automatic provisioning, reconnect or replay is supplied.
- Web workspace UIs read the composed filesystem, so a remote deployment lists, opens and edits remote directories; the adaptive directory chooser mounts its in-app browser rather than an OS-native dialog, which could only return a host path.
- One `ssh` row serves one world, and the Web workspace menus offer one add action per reachable world. Executable resolution and the terminal environment carry no target, so a deployment composing named worlds refuses those lookups.
- TLS stream keys do not protect against remote OS process-memory inspection or debugging. File-effect policy retains the selected sandbox backend’s limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Wire validation and the owning filesystem, subprocess and sandbox providers enforce the observable obligations; this adapter adds no independently observed state relation.

</details>
