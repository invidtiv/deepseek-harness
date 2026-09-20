/** Remote argv wrapper that selects and applies the sandbox on the SSH host. */
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SshWorldConnection } from '@deepseek-ai/dsh-ssh'
import { z } from 'zod'

const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()

/**
 * Resolve each confinement request on the same host as its filesystem and
 * subprocess providers. A deployment that also composes the local execution
 * world confines there for a workspace root no SSH world claims.
 */
export class SshSandboxProvider extends SandboxProvider {
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    const local = this.localFor(policy.workspaceRoot)
    if (local !== undefined) return await local.confine(argv, policy, signal)
    try {
      // The policy's workspace root selects the world whose backend resolves and
      // applies the sandbox; a targetless deployment keeps its own connection.
      const worlds = this.ctx.get('sshWorlds')
      const ssh = worlds === undefined ? this.ownConnection() : worlds.connectionFor(policy.workspaceRoot)
      const confined = await ssh.request('sandbox', { argv, policy }, factsSchema, signal)
      signal?.throwIfAborted()
      return {
        ...confined,
        runnerFailureRules: confined.runnerFailureRules.map(rule => ({
          fatalSignatures: rule.fatalSignatures,
          ...(rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: rule.allowedExitCodes }),
          ...(rule.informationalLines === undefined ? {} : { informationalLines: rule.informationalLines }),
        })),
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new SandboxUnavailableError(policy.mode, error instanceof Error ? error.message : String(error))
    }
  }

  /** The deployment's own single connection; a mixed deployment reads it from its pool instead. */
  private ownConnection(): SshWorldConnection {
    const own = this.ctx.get('ssh', false) as SshWorldConnection | undefined
    if (own === undefined) throw new Error('ssh: no default world connection is composed')
    return own
  }

  /** The local delegate for a workspace root no SSH world claims, or undefined for a remote target. */
  private localFor(root: string): SandboxProvider | undefined {
    const local = this.ctx.get('localSandbox') as SandboxProvider | undefined
    if (local === undefined) return undefined
    return this.ctx.get('sshWorlds')?.worldFor(root) === undefined ? local : undefined
  }
}

export default SshSandboxProvider
