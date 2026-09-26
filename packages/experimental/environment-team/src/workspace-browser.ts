/** Destination-side workspace operations confined to currently granted canonical directories. */
import { mkdir, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ResolvedConfig } from './config.ts'
import type { EnvironmentId } from './protocol.ts'
import type { EnvironmentWorkspace, WorkspaceRequest, WorkspaceResult } from './workspace-types.ts'
import { workspaceRequestSchema } from './workspace-protocol.ts'

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

/** Reads and mutates only this installation's workspace registry and filesystem. */
export class EnvironmentWorkspaceBrowser {
  constructor(private readonly ctx: Context, private readonly id: EnvironmentId, private readonly config: ResolvedConfig) {}

  /**
   * Execute a workspace operation after rechecking the caller's current alias grants.
   * @param peer - authenticated installation, or this installation for its local operator.
   * @param input - destination-relative workspace request.
   * @returns the complete bounded result, with no data from another installation.
   */
  async run(peer: EnvironmentId, input: WorkspaceRequest): Promise<WorkspaceResult> {
    const request = workspaceRequestSchema.parse(input)
    const grant = this.config.peers.find(item => item.environmentId === peer)
    if (peer !== this.id && !grant?.workspaceManagement) throw new Error('workspace management is not granted')
    const aliases = Object.entries(this.config.workspaces).filter(([alias]) => peer === this.id || grant?.workspaces.includes(alias))
    const roots = await Promise.all(aliases.map(async ([alias, path]) => ({ alias, path: await realpath(path) })))
    let result: WorkspaceResult
    if (request.action === 'catalog') {
      const workspaces: EnvironmentWorkspace[] = []
      let truncated = roots.length > this.config.workspacePageSize
      for (const workspace of this.ctx.workspaceRegistry.list()) {
        const root = roots.find(item => within(item.path, workspace.path))
        if (!root) continue
        if (workspaces.length === this.config.workspacePageSize) { truncated = true; break }
        const actual = await realpath(workspace.path).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
          throw error
        })
        if (actual && within(root.path, actual)) workspaces.push(this.view(root, workspace))
      }
      result = { kind: 'catalog', roots: roots.slice(0, this.config.workspacePageSize), workspaces, truncated }
    } else {
      const root = roots.find(item => item.alias === request.alias)
      if (!root) throw new Error('workspace alias is not granted')
      let target = await realpath(join(root.path, ...request.relativePath.split('/')))
      if (!within(root.path, target) || !(await stat(target)).isDirectory()) throw new Error('directory is outside the granted root')
      if (request.action === 'mkdir') {
        const child = join(target, request.name)
        try { await mkdir(child) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        }
        target = await realpath(child)
        if (!within(root.path, target) || !(await stat(target)).isDirectory()) throw new Error('directory is outside the granted root')
      }
      if (request.action === 'register') {
        result = { kind: 'registered', workspace: this.view(root, await this.ctx.workspaceRegistry.create(target)) }
      } else {
        const entries: { name: string; relativePath: string }[] = []
        let truncated = false
        for await (const entry of await opendir(target)) {
          if (!entry.isDirectory()) continue
          if (entries.length === this.config.workspacePageSize) { truncated = true; break }
          entries.push({ name: entry.name, relativePath: relative(root.path, join(target, entry.name)).split(sep).join('/') })
        }
        entries.sort((left, right) => left.name.localeCompare(right.name))
        result = { kind: 'directory', alias: root.alias, relativePath: relative(root.path, target).split(sep).join('/'), path: target, entries, truncated }
      }
    }
    if (Buffer.byteLength(JSON.stringify({ environmentId: this.id, result: JSON.stringify(result) })) > this.config.maxBytes) throw new Error('workspace result byte limit reached')
    return result
  }

  private view(root: { alias: string; path: string }, workspace: Workspace): EnvironmentWorkspace {
    return { environmentId: this.id, workspaceId: workspace.id, alias: root.alias, relativePath: relative(root.path, workspace.path).split(sep).join('/'), path: workspace.path, title: workspace.title }
  }
}
