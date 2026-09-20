# SSH

English | [中文](ssh.zh.md)

The [SSH provider family](../../packages/ssh/README.md) supplies one remote filesystem/process world through a deployment-owned OpenSSH connection. The Harness, model transport and Session storage remain on the host. The family implements the existing filesystem, subprocess and sandbox APIs; it introduces no SSH-specific model tools.

## Execution coordinates

Filesystem identities, executable lookup, process cwd, sandbox workspace roots and language-server file URLs refer to the SSH host. Providers canonicalize paths where the files exist, preserving filesystem interpretation of `symlink/..`. The policy resolver carries absolute execution-world spelling without trying to resolve remote paths on the Harness host.

`processPath()` supplies a path usable by the paired subprocess provider. `processPathFromHostPath()` remains unavailable for SSH; installing a remote artifact does not make an arbitrary host path portable. [`NodePtcRuntime`](../../packages/ptc-runtime/ptc-runtime-node/README.md) therefore takes an explicitly installed, digest-verified remote bootstrap.

## Transport and trust

Administrative RPC uses the helper’s SSH exec streams. Ordinary stdin, stdout, stderr, terminal output and optional fd 7 control traffic use separately authenticated forwarded Unix sockets. Each forwarded stream has its own SSH channel window; paused program output does not share the control or administrative window. All channels still share connection bandwidth and transport failure.

Deployment authentication, installed artifact verification and per-stream TLS authentication belong to [`dsh-ssh`](../../packages/ssh/ssh/README.md). The helper executes filesystem and process requests with trusted local providers on the remote machine. SSH is a transport; the selected remote sandbox provider enforces file effects.

## Process lifetime and cancellation

A process is reserved before its streams are connected, and launch is accepted at most once. `done` reports the direct result; `waitForExit` observes the remote managed range. Terminal operations retain the asynchronous shared API. Preparation cancellation, launched-process termination and provider disposal release their owned resources through the helper.

Administrative deadlines bound individual RPC observations; they do not replace the execution deadline chosen by a Bash or ptc-runtime consumer. Remote waits can remain pending while other requests progress. SSH loss invalidates pending operations; helper EOF, signals and lease expiry start remote cleanup. The client reports unconfirmed outcomes honestly and never reconnects to replay a possibly executed action.

## Composition scope

Headless records and checks Session cwd through the mounted filesystem provider. Remote FS, Bash, terminal, LSP and PTC consumers can therefore share those coordinates. Web workspace views that assume host filesystem access need separate integration; replacing providers alone does not make those views remote-aware.

See the [decision record](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) for the alternatives and verification obligations.

## Environment configuration

The [environment registry](../../packages/ssh/ssh-environments/README.md) stores named `SshEnvironment` connection options in the `ssh-environments` settings namespace and resolves them on `ctx.sshEnvironments`. A `SshEnvironment` carries the OpenSSH destination plus optional `port`, `user`, `identityFile`, `identityAgent`, `proxyJump`, `configFile`, `hostKeyChecking`, `connectTimeoutMs`, `serverAliveIntervalMs` and `serverAliveCountMax`; an absent field leaves OpenSSH's own default in effect, so a deployment may keep connection details in `~/.ssh/config`. The registry owns configuration only: the connection, helper verification and remote cleanup remain with `dsh-ssh`, and no environment value reaches a model request.

## Connection API

```ts type-equiv
/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
interface Config {
  /** OpenSSH destination: a config-file alias, a host name, or an address; mutually exclusive with `environment`. */
  host?: string
  /** Named environment resolved through the `ssh-environments` settings registry; mutually exclusive with `host`. */
  environment?: string
  /** Absolute remote Node executable. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
  /** Explicit OpenSSH port; absent keeps the config file's value. */
  port?: number
  /** Explicit login user; absent keeps the config file's value. */
  user?: string
  /** Private-key path passed as `-i`; absent keeps the config file's and agent's identities. */
  identityFile?: string
  /** Agent socket passed as `IdentityAgent`; absent uses `SSH_AUTH_SOCK`. */
  identityAgent?: string
  /** `ProxyJump` destination for a bastion chain. */
  proxyJump?: string
  /** Alternate OpenSSH config file passed as `-F`. */
  configFile?: string
  /** Host-key policy; the default refuses an unknown or changed key. */
  hostKeyChecking?: 'yes' | 'accept-new' | 'no'
  /** `ConnectTimeout` in milliseconds; absent keeps the OpenSSH default. */
  connectTimeoutMs?: number
  /** `ServerAliveInterval` in milliseconds. */
  serverAliveIntervalMs?: number
  /** `ServerAliveCountMax` probe count. */
  serverAliveCountMax?: number
}
```

```ts public-api
/** One non-reconnecting SSH session; loss invalidates all active operations. */
declare class SshConnection extends Service {
  static Config: schema<Config>;
  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>;
  /**
   * Named ssh-environments registry identity this connection resolved; absent
   * when the connection was configured with an inline OpenSSH destination.
   * Owners that project where workspace directories live read it by service
   * name, so they need no dependency on this package.
   */
  readonly environmentId: string | undefined;
  constructor(ctx: Context, config: Config);
  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void>;
  /** Verified remote Node executable for the paired PTC runtime. */
  get nodeExecutable(): string;
  /** Verified remote PTC bootstrap entry; absent when the deployment configured none. */
  get launchBootstrap(): string | undefined;
  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string;
  /**
     * Send a helper operation; cancellation never replays an ambiguous mutation.
     * @param method - the private helper operation.
     * @param params - JSON request fields validated by the helper.
     * @param result - response validation before returning provider-visible data.
     * @param signal - cancellation, which does not undo completed remote effects.
     * @param wait - allow a process observation to outlast the administrative deadline.
     * @returns the validated remote result.
     */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>;
  /**
     * Forward one authenticated stream through an independent SSH channel.
     * @param endpoint - private coordinates issued by this connection's helper.
     * @param signal - cancellation of allocation and the resulting socket.
     * @returns a paused socket; attach a consumer before resuming it.
     */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>;
  /** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
  dispose(): Promise<void>;
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxssh--sshconnection"></a>

### `ctx.ssh` — `SshConnection`

One non-reconnecting SSH session; loss invalidates all active operations.

```ts cordis-catalog
/**
 * Send a helper operation; cancellation never replays an ambiguous mutation.
 * @param method - the private helper operation.
 * @param params - JSON request fields validated by the helper.
 * @param result - response validation before returning provider-visible data.
 * @param signal - cancellation, which does not undo completed remote effects.
 * @param wait - allow a process observation to outlast the administrative deadline.
 * @returns the validated remote result.
 */
async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>

/**
 * Forward one authenticated stream through an independent SSH channel.
 * @param endpoint - private coordinates issued by this connection's helper.
 * @param signal - cancellation of allocation and the resulting socket.
 * @returns a paused socket; attach a consumer before resuming it.
 */
async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>

/** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
dispose(): Promise<void>
```

Source: [`packages/ssh/ssh/src/index.ts`](../../packages/ssh/ssh/src/index.ts)

<a id="ctxsshbroker--sshbroker"></a>

### `ctx.sshBroker` — `SshBroker`

Opens one connection per configured environment on first use and releases them together.

```ts cordis-catalog
/**
 * Environment ids this deployment can connect to: the configured entries
 * that declare every remote runtime coordinate a connection needs.
 * @returns the connectable environment ids, in declaration order.
 */
list(): readonly string[]

/**
 * Connect to one environment, composing the connection on first use.
 * Concurrent callers share one attempt.
 * @param id - stable environment identity.
 * @returns the live connection providers route to.
 * @throws {SshEnvironmentUnknownError} when the id is not configured.
 * @throws {SshEnvironmentIncompleteError} when its runtime coordinates are incomplete.
 */
connect(id: string): Promise<SshWorldConnection>

/**
 * List one directory level in a named environment, composing its connection
 * on first use. The remote host's own POSIX spelling is preserved, so a
 * caller on any host platform sees canonical remote paths.
 * @param id - stable environment identity.
 * @param path - absolute remote directory; absent lists the environment's workspace.
 * @param signal - caller lifetime, which stops the remote scan.
 * @returns the listed level with its ancestry and the environment's workspace.
 */
async listDirectory(id: string, path?: string, signal?: AbortSignal): Promise<SshRemoteDirectory>

/**
 * Create one child directory in a named environment.
 * @param id - stable environment identity.
 * @param path - absolute remote parent that already exists.
 * @param name - single child segment.
 * @param policy - file-effect policy the creation runs under.
 * @param signal - caller lifetime.
 * @returns the created directory's canonical absolute remote path.
 */
async createDirectory(id: string, path: string, name: string, policy: SshRemoteDirectoryPolicy, signal?: AbortSignal): Promise<string>
```

Source: [`packages/ssh/ssh/src/broker.ts`](../../packages/ssh/ssh/src/broker.ts)

<a id="ctxsshenvironments--sshenvironments"></a>

### `ctx.sshEnvironments` — `SshEnvironments`

Registry over the deployment's named SSH environments.

The service registers the SSH_ENVIRONMENTS_NAMESPACE settings namespace during activation and resolves a stable id into validated OpenSSH connection options (resolve) or into those options plus the remote runtime coordinates a helper launch needs (resolveRuntime). It never opens a connection and never stores a secret; the SSH provider family owns both.

```ts cordis-catalog
/**
 * List configured environments in declaration order.
 * @returns one client-safe summary per environment.
 */
list(): readonly SshEnvironmentSummary[]

/**
 * Read one environment's stored entry.
 * @param id - stable environment identity.
 * @returns the entry, or `undefined` when the id is not configured.
 */
get(id: SshEnvironmentId): SshEnvironmentEntry | undefined

/**
 * Resolve one environment into validated OpenSSH connection options with this
 * provider's defaults applied.
 * @param id - stable environment identity.
 * @returns the resolved connection options.
 * @throws {SshEnvironmentUnknownError} when the id is not configured.
 */
resolve(id: SshEnvironmentId): SshEnvironment

/**
 * Resolve one environment into everything a connection needs: the OpenSSH
 * options plus the remote runtime coordinates (Node, helper entry, helper
 * digest, and default workspace) the helper is launched with. An entry that
 * omits `workspace` resolves to {@link SSH_ENVIRONMENT_DEFAULT_WORKSPACE}.
 * @param id - stable environment identity.
 * @returns the resolved connection and remote runtime coordinates.
 * @throws {SshEnvironmentUnknownError} when the id is not configured.
 * @throws {SshEnvironmentIncompleteError} when a required runtime coordinate is absent.
 */
resolveRuntime(id: SshEnvironmentId): SshEnvironmentRuntime
```

Source: [`packages/ssh/ssh-environments/src/index.ts`](../../packages/ssh/ssh-environments/src/index.ts)

<a id="ctxsshworlds--sshworlds"></a>

### `ctx.sshWorlds` — `SshWorlds`

Routes each remote operation to the connection that owns its target's world.

```ts cordis-catalog
/**
 * Register one composed connection for the world it serves.
 * @param environmentId - the world's environment id; undefined is the deployment default.
 * @param connection - the connection that owns that world.
 * @returns the disposer removing this registration.
 */
register(environmentId: string | undefined, connection: SshWorldConnection): () => void

/**
 * List the worlds with a composed connection.
 * @returns the environment ids in registration order; the default connection contributes none.
 */
list(): readonly string[]

/**
 * Resolve one named world's connection explicitly, without consulting the
 * workspace locators: a caller that already knows the world it addresses
 * (an operator-chosen environment, a target that records it) needs no claim.
 * @param environmentId - world to resolve.
 * @returns the connection serving that world.
 * @throws {SshWorldUnavailableError} when no connection is composed for it.
 */
connectionForEnvironment(environmentId: string): SshWorldConnection

/**
 * Refuse an operation that carries no target while named worlds are composed.
 * @param operation - the provider operation that needs a single world.
 * @throws {SshWorldMultipleError} when more than one named world is composed.
 */
requireDefaultWorld(operation: string): void

/**
 * Resolve the connection one remote path belongs to.
 * @param path - absolute remote path in some composed world.
 * @returns the connection serving that path's world.
 * @throws {SshWorldUnavailableError} when the path's world has no composed connection.
 * @throws {SshWorldAmbiguousError} when two worlds claim the path.
 */
connectionFor(path: string): SshWorldConnection

/**
 * Resolve the world one remote path belongs to: the longest owning locator wins.
 * @param path - absolute remote path in some composed world.
 * @returns the owning environment id, or undefined for the default connection.
 * @throws {SshWorldAmbiguousError} when two worlds claim the same directory.
 */
worldFor(path: string): string | undefined
```

Source: [`packages/ssh/ssh/src/worlds.ts`](../../packages/ssh/ssh/src/worlds.ts)
<!-- END GENERATED cordis-surface -->
