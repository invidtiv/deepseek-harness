/**
 * The five topic commands over the harness command runtime, so any frontend
 * can discover them and every execution logs `command/run`/`command/done`.
 * `/folder` and `/help` also work before a topic has a session (handled
 * directly by the runtime, which owns the reply).
 * @module @deepseek-ai/dsh-telegram/src/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionIdForKey, TopicRegistry } from './topics.ts'
import type { TopicRegistry as TopicRegistryType } from './topics.ts'
import type { SessionManager } from './sessions.ts'
import type { WorkspaceGuard } from './workspaces.ts'
import type { TopicKey } from './types.ts'

const HELP_TEXT = [
  '/status — session id, workspace, state, queued messages',
  '/folder [path] — show or select the topic workspace (allowed roots only)',
  '/reset — archive this session and start a fresh one in the same workspace',
  '/cancel — abort the running turn and drop queued messages',
  '/help — this list',
].join('\n')

/**
 * Command set bound to one mapping registry, session manager, and workspace
 * guard. Handlers return plain `CommandResult` text; the Telegram runtime
 * renders it in the topic.
 */
export class CommandAdapter {
  /**
   * @param ctx - Context for optional workspace-registry reads.
   * @param registry - The topic mapping registry.
   * @param sessions - The session manager.
   * @param guard - The workspace guard, resolved per call so a settings change swaps the allowed roots live.
   * @param logger - Structured logger.
   */
  constructor(
    private readonly ctx: Context,
    private readonly registry: TopicRegistryType,
    private readonly sessions: SessionManager,
    private readonly guard: () => Promise<WorkspaceGuard>,
    private readonly logger: Context['logger'],
  ) {}

  /**
   * Register the five commands; returns their disposers (the runtime owns the effects).
   * @param commands - Command runtime the five entries register into.
   * @returns one disposer per registered command, in registration order; the caller unregisters through them.
   */
  register(commands: CommandRuntime): Array<() => void> {
    return [
      commands.register({ name: 'status', description: 'Show the topic session state', handler: invocation => this.status(invocation.agent) }),
      commands.register({
        name: 'folder',
        description: 'Show or select the topic workspace',
        input: { hint: '[path]' },
        handler: invocation => this.folder(invocation.agent, invocation.rawInput),
      }),
      commands.register({ name: 'reset', description: 'Archive the topic session and start fresh', handler: invocation => this.reset(invocation.agent) }),
      commands.register({ name: 'cancel', description: 'Abort the running turn and drop queued messages', handler: invocation => this.cancel(invocation.agent) }),
      commands.register({ name: 'help', description: 'List topic commands', handler: () => this.help() }),
    ]
  }

  /**
   * Handle `/folder` or `/help` for a topic that has no session yet (the
   * command runtime needs an agent, so this path bypasses it and logs no
   * `command/run`).
   * @param line - The raw command line.
   * @param key - The topic key.
   * @returns the reply text, or `undefined` when the line is not one of the two.
   */
  async handleDirect(line: string, key: TopicKey): Promise<string | undefined> {
    const match = /^\/(folder|help)(?:[ \t](.*))?$/u.exec(line.trim())
    if (match === null) return undefined
    if (match[1] === 'help') return HELP_TEXT
    const argument = (match[2] ?? '').trim()
    return await this.folderText(key, argument, false)
  }

  /** `/status`: session identity, workspace, run state, queue depth. */
  private status(agent: Agent): CommandResult {
    const topic = this.sessions.topicForAgent(agent)
    const key = topic?.key ?? this.registry.keyOfSession(agent.session.id)
    const record = key === undefined ? undefined : this.registry.get(key)
    if (record === undefined || topic === undefined) {
      return { kind: 'error', text: 'This session is not a Telegram topic session.' }
    }
    const workspace = record.pendingWorkspace ?? record.workspace ?? '(none)'
    const state = topic.agent.status === 'running' ? 'running' : 'idle'
    const lines = [
      `Session: ${record.sessionId ?? '(none yet)'}`,
      `Workspace: ${workspace}`,
      `State: ${state}`,
      `Created: ${record.createdAt}`,
      `Queued: ${this.sessions.pendingCount(topic)}`,
    ]
    return { kind: 'success', text: lines.join('\n') }
  }

  /** `/folder`: list current selection plus allowed roots, or select for the next session. */
  private async folder(agent: Agent, rawInput: string): Promise<CommandResult> {
    const topic = this.sessions.topicForAgent(agent)
    const key = topic?.key ?? this.registry.keyOfSession(agent.session.id)
    if (key === undefined) return { kind: 'error', text: 'This session is not a Telegram topic session.' }
    const text = await this.folderText(key, rawInput.trim(), topic !== undefined)
    return { kind: 'success', text }
  }

  /** `/reset`: archive the current session, start a fresh generation in the same topic. */
  private async reset(agent: Agent): Promise<CommandResult> {
    const topic = this.sessions.topicForAgent(agent)
    if (topic === undefined) return { kind: 'error', text: 'This session is not a live Telegram topic session.' }
    const key = topic.key
    const row = this.registry.get(key)
    if (row === undefined) return { kind: 'error', text: 'This topic has no mapping row.' }
    const workspaceRegistry = this.ctx.get('workspaceRegistry')
    let retired: { retired: SessionId; workspace: string }
    try {
      retired = await this.sessions.retire(
        topic,
        workspaceRegistry === undefined ? undefined : sessionId => workspaceRegistry.archiveSession(sessionId),
      )
    } catch (error) {
      return { kind: 'error', text: `Reset failed: ${String(error)}` }
    }
    const generation = row.generation + 1
    await this.registry.putHistory(key, row.generation, {
      chatId: row.chatId,
      threadId: row.threadId,
      sessionId: retired.retired,
      workspace: retired.workspace,
      createdAt: row.createdAt,
      archivedAt: new Date().toISOString(),
    })
    await this.registry.put(key, {
      ...row,
      sessionId: null,
      generation,
      workspace: retired.workspace,
      pendingWorkspace: null,
      lastActivity: new Date().toISOString(),
    })
    const resolution = await this.sessions.resolve(key)
    if (!resolution.ok) return { kind: 'error', text: `Reset completed but the fresh session failed: ${resolution.reply}` }
    const sessionId = sessionIdForKey(key, generation)
    this.logger.info(`telegram: reset topic ${key}; archived ${retired.retired}, started ${sessionId}`)
    return { kind: 'success', text: `Reset complete — fresh session ${sessionId} in '${retired.workspace}'.` }
  }

  /** `/cancel`: abort the running turn and drop queued messages. */
  private cancel(agent: Agent): CommandResult {
    const topic = this.sessions.topicForAgent(agent)
    if (topic === undefined) return { kind: 'error', text: 'This session is not a live Telegram topic session.' }
    topic.agent.cancel({ kind: 'user' })
    return { kind: 'success', text: 'Cancelled.' }
  }

  /** `/help`: the five lines. */
  private help(): CommandResult {
    return { kind: 'success', text: HELP_TEXT }
  }

  /** Shared `/folder` body for the command path (with session) and the direct path (without). */
  private async folderText(key: TopicKey, argument: string, hasSession: boolean): Promise<string> {
    const row = this.registry.get(key)
    const guard = await this.guard()
    if (argument === '') {
      const current = row?.pendingWorkspace ?? row?.workspace ?? '(none)'
      const options = guard.canonicalRoots
      const lines = [
        `Current workspace: ${current}`,
        'Allowed roots:',
        ...options.map(root => `- ${root}`),
        'Select with /folder <path> (must be inside an allowed root).',
      ]
      return lines.join('\n')
    }
    let canonical: string
    try {
      canonical = await guard.select(argument)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    const now = new Date().toISOString()
    if (row === undefined) {
      const ref = TopicRegistry.parse(key)
      await this.registry.put(key, {
        chatId: ref.chatId,
        threadId: ref.threadId,
        sessionId: null,
        generation: 1,
        workspace: canonical,
        pendingWorkspace: null,
        createdAt: now,
        lastActivity: now,
      })
    } else if (row.sessionId === null) {
      await this.registry.put(key, { ...row, workspace: canonical, pendingWorkspace: null, lastActivity: now })
    } else {
      await this.registry.put(key, { ...row, pendingWorkspace: canonical, lastActivity: now })
    }
    this.logger.info(`telegram: topic ${key} workspace selected: ${canonical}`)
    if (!hasSession) return `Workspace set to '${canonical}'. Send a message to start.`
    return `Workspace will change to '${canonical}' with /reset (the current session keeps its folder).`
  }
}
