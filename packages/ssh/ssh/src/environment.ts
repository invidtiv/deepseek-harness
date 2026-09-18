/** OpenSSH connection parameters and master argv for one POSIX SSH environment. */

import { z } from 'zod'

/**
 * Host-key verification policy carried to OpenSSH as
 * `StrictHostKeyChecking`. `yes` refuses an unknown or changed key,
 * `accept-new` trusts an unknown key once and still refuses a changed one,
 * and `no` accepts either without a known-hosts entry.
 */
export type HostKeyChecking = 'yes' | 'accept-new' | 'no'

/**
 * Connection parameters for one POSIX SSH environment. `host` is the
 * OpenSSH destination (a `~/.ssh/config` alias, a host name, or an address);
 * every other field is an explicit OpenSSH option that overrides or extends
 * that alias. An absent optional field leaves OpenSSH's own default in
 * effect, so a deployment may keep connection details in `~/.ssh/config`.
 */
export interface SshEnvironment {
  /** OpenSSH destination: an alias from a config file, a host name, or an address. */
  host: string
  /** TCP port; absent uses the OpenSSH default or the config file's value. */
  port?: number
  /** Login user; absent uses the config file's value or the local user. */
  user?: string
  /** Private-key path passed as `-i`; `~` is accepted. */
  identityFile?: string
  /** Agent socket passed as `IdentityAgent`; absent uses `SSH_AUTH_SOCK`. */
  identityAgent?: string
  /** `ProxyJump` destination (`[user@]host[:port]`) for a bastion chain. */
  proxyJump?: string
  /** Alternate OpenSSH config file passed as `-F`; `~` is accepted. */
  configFile?: string
  /** Host-key policy; the resolved default is `yes`. */
  hostKeyChecking?: HostKeyChecking
  /** `ConnectTimeout` in milliseconds; absent leaves the OpenSSH default. */
  connectTimeoutMs?: number
  /** `ServerAliveInterval` in milliseconds; absent disables the client probe. */
  serverAliveIntervalMs?: number
  /** `ServerAliveCountMax` probe count; meaningful only with an interval. */
  serverAliveCountMax?: number
}


/** Connection source and OpenSSH option overrides for one SSH connection. */
export interface SshConnectionSelection {
  /** OpenSSH destination; mutually exclusive with {@link SshConnectionSelection.environment}. */
  host?: string
  /** Named environment resolved through the ssh-environments registry; mutually exclusive with {@link SshConnectionSelection.host}. */
  environment?: string
  /** TCP port; absent uses the OpenSSH default or the config file's value. */
  port?: number
  /** Login user; absent uses the config file's value or the local user. */
  user?: string
  /** Private-key path passed as `-i`; `~` is accepted. */
  identityFile?: string
  /** Agent socket passed as `IdentityAgent`; absent uses `SSH_AUTH_SOCK`. */
  identityAgent?: string
  /** `ProxyJump` destination for a bastion chain. */
  proxyJump?: string
  /** Alternate OpenSSH config file passed as `-F`; `~` is accepted. */
  configFile?: string
  /** Host-key policy; the resolved default is `yes`. */
  hostKeyChecking?: HostKeyChecking
  /** `ConnectTimeout` in milliseconds; absent leaves the OpenSSH default. */
  connectTimeoutMs?: number
  /** `ServerAliveInterval` in milliseconds; absent disables the client probe. */
  serverAliveIntervalMs?: number
  /** `ServerAliveCountMax` probe count; meaningful only with an interval. */
  serverAliveCountMax?: number
}

/**
 * The SSH environment registry contract the connection reads by service name
 * (`ctx.sshEnvironments`, implemented by `dsh-ssh-environments`). Reading it by
 * name keeps the connection package free of a dependency on the registry.
 */
export interface SshEnvironmentResolver {
  /**
   * Resolve one configured environment into connection options.
   * @param id - configured environment identity.
   * @returns the resolved connection options.
   */
  resolve(id: string): SshEnvironment
}

const MAX_TIMEOUT_MS = 2_147_483_647

/** A non-empty value that cannot break the one-option-per-argument argv. */
function argument(label: string): z.ZodString {
  return z.string().min(1).refine(value => !/[\0\r\n]/u.test(value), `${label} must not contain NUL or a line break`)
}

/** A path OpenSSH may expand from `~` or resolve absolutely. */
function filePath(label: string): z.ZodString {
  return argument(label).refine(value => value.startsWith('/') || value.startsWith('~/'), `${label} must be absolute or start with ~/`)
}

const sshEnvironmentSchema = z.object({
  host: argument('host').regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/, 'host must be an OpenSSH destination'),
  port: z.number().int().min(1).max(65_535).optional(),
  user: argument('user').regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'user must be a login name').optional(),
  identityFile: filePath('identityFile').optional(),
  identityAgent: argument('identityAgent').optional(),
  proxyJump: argument('proxyJump').optional(),
  configFile: filePath('configFile').optional(),
  hostKeyChecking: z.enum(['yes', 'accept-new', 'no']).optional(),
  connectTimeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  serverAliveIntervalMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  serverAliveCountMax: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional(),
}).strict()

/**
 * Validate one SSH environment and apply the connection defaults this provider
 * owns: strict host-key checking and a 10-second / 3-probe client keepalive.
 * The returned object is a detached value with every `-o` argument checked for
 * NUL and line breaks, so it is safe to hand to {@link buildMasterArgv}.
 * @param value - untrusted environment fields from configuration or a registry.
 * @returns the validated environment with owned defaults applied.
 */
export function resolveSshEnvironment(value: unknown): SshEnvironment {
  const parsed = sshEnvironmentSchema.parse(value)
  return {
    host: parsed.host,
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
    ...(parsed.user === undefined ? {} : { user: parsed.user }),
    ...(parsed.identityFile === undefined ? {} : { identityFile: parsed.identityFile }),
    ...(parsed.identityAgent === undefined ? {} : { identityAgent: parsed.identityAgent }),
    ...(parsed.proxyJump === undefined ? {} : { proxyJump: parsed.proxyJump }),
    ...(parsed.configFile === undefined ? {} : { configFile: parsed.configFile }),
    hostKeyChecking: parsed.hostKeyChecking ?? 'yes',
    ...(parsed.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: parsed.connectTimeoutMs }),
    serverAliveIntervalMs: parsed.serverAliveIntervalMs ?? 10_000,
    serverAliveCountMax: parsed.serverAliveCountMax ?? 3,
  }
}

/**
 * Resolve one connection's execution options: a named environment through the
 * registry, or an inline OpenSSH destination with per-field overrides. Exactly
 * one of `host` and `environment` must be present; a named environment whose
 * registry is not composed fails loud rather than connecting elsewhere.
 * @param selection - inline destination and option overrides, or an environment id.
 * @param resolver - the composed environment registry, or undefined when none is.
 * @returns the resolved connection options with owned defaults applied.
 */
export function resolveConnectionEnvironment(
  selection: SshConnectionSelection,
  resolver: SshEnvironmentResolver | undefined,
): SshEnvironment {
  if (selection.environment !== undefined) {
    if (resolver === undefined) {
      throw new Error(`ssh: environment "${selection.environment}" requires the ssh-environments registry composed before this connection`)
    }
    return resolver.resolve(selection.environment)
  }
  if (selection.host === undefined) throw new Error('ssh: one of host or environment is required')
  return resolveSshEnvironment({
    host: selection.host,
    ...(selection.port === undefined ? {} : { port: selection.port }),
    ...(selection.user === undefined ? {} : { user: selection.user }),
    ...(selection.identityFile === undefined ? {} : { identityFile: selection.identityFile }),
    ...(selection.identityAgent === undefined ? {} : { identityAgent: selection.identityAgent }),
    ...(selection.proxyJump === undefined ? {} : { proxyJump: selection.proxyJump }),
    ...(selection.configFile === undefined ? {} : { configFile: selection.configFile }),
    ...(selection.hostKeyChecking === undefined ? {} : { hostKeyChecking: selection.hostKeyChecking }),
    ...(selection.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: selection.connectTimeoutMs }),
    ...(selection.serverAliveIntervalMs === undefined ? {} : { serverAliveIntervalMs: selection.serverAliveIntervalMs }),
    ...(selection.serverAliveCountMax === undefined ? {} : { serverAliveCountMax: selection.serverAliveCountMax }),
  })
}

/** Convert milliseconds to the whole seconds an OpenSSH `-o` option takes. */
function toSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000))
}

/**
 * Build the argument list for the long-lived OpenSSH master that carries the
 * remote helper. The list never includes the leading `ssh` program name.
 * Forwarding and interactive authentication stay disabled regardless of the
 * environment, and every other option comes from the resolved environment.
 * @param environment - a resolved environment from {@link resolveSshEnvironment}.
 * @param controlPath - absolute path of the multiplexing control socket.
 * @param remoteCommand - command string the master runs after connecting; omitted for control commands.
 * @returns the argv for `spawn('ssh', argv)`.
 */
export function buildMasterArgv(environment: SshEnvironment, controlPath: string, remoteCommand?: string): string[] {
  const argv = ['-T', '-M', '-S', controlPath]
  if (environment.configFile !== undefined) argv.push('-F', environment.configFile)
  argv.push(
    '-o', 'ControlPersist=no',
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${environment.hostKeyChecking ?? 'yes'}`,
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
  )
  if (environment.serverAliveIntervalMs !== undefined) argv.push('-o', `ServerAliveInterval=${String(toSeconds(environment.serverAliveIntervalMs))}`)
  if (environment.serverAliveCountMax !== undefined) argv.push('-o', `ServerAliveCountMax=${String(environment.serverAliveCountMax)}`)
  if (environment.connectTimeoutMs !== undefined) argv.push('-o', `ConnectTimeout=${String(toSeconds(environment.connectTimeoutMs))}`)
  if (environment.proxyJump !== undefined) argv.push('-o', `ProxyJump=${environment.proxyJump}`)
  if (environment.identityAgent !== undefined) argv.push('-o', `IdentityAgent=${environment.identityAgent}`)
  if (environment.identityFile !== undefined) argv.push('-i', environment.identityFile)
  if (environment.port !== undefined) argv.push('-p', String(environment.port))
  if (environment.user !== undefined) argv.push('-l', environment.user)
  argv.push(environment.host)
  if (remoteCommand !== undefined) argv.push(remoteCommand)
  return argv
}
