/** Protocol-specific delivery of one ACP session's semantic updates. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AvailableCommand,
  PlanEntry,
  SessionConfigOption,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { AcpToolCursor } from './tool-projection.ts'
import { eventUpdates } from './updates.ts'

/** Why foreground work went idle; `error` reports a failed turn without failing a request. */
export type IdleReason = StopReason | 'error'

/** Foreground activity of one session; v2 also displays failure detail as a diagnostic message. */
export type ForegroundState =
  | { state: 'running' }
  | { state: 'requires_action' }
  | { state: 'idle'; stopReason?: IdleReason; error?: string }

/**
 * Delivery of one session's updates in one negotiated protocol version. Each
 * method sends its notifications and settles after they are written; the caller
 * owns ordering. Rejection means a committed fact could not be projected;
 * implementations contain transport write failures.
 */
export interface AcpOutput {
  /**
   * Send the transcript projections of one committed event.
   * @param session - authoritative event-owning session.
   * @param event - committed durable event.
   * @param replay - history replay rather than live delivery.
   */
  event(session: Session, event: SessionEvent, replay: boolean): Promise<void>
  /**
   * Replace the client's standing plan.
   * @param entries - complete plan; empty clears it.
   */
  plan(entries: readonly PlanEntry[]): Promise<void>
  /**
   * Append transient shell output; the committed result replaces this preview.
   * @param callId - owning model invocation.
   * @param text - new retained output bytes decoded as text.
   */
  toolOutput(callId: ToolCallId, text: string): Promise<void>
  /**
   * Replace the client's configuration options.
   * @param options - complete standard option state.
   */
  configOptions(options: readonly SessionConfigOption[]): Promise<void>
  /**
   * Replace the client's command list.
   * @param commands - complete standard command descriptors.
   */
  commands(commands: readonly AvailableCommand[]): Promise<void>
  /**
   * Send one status line as its own assistant message.
   * @param messageId - live-only identity of the status message.
   * @param text - complete status text.
   */
  status(messageId: string, text: string): Promise<void>
  /**
   * Send a direct command result and, where the protocol echoes prompts, the command line.
   * @param messageId - live-only identity of the command line.
   * @param line - command text as submitted.
   * @param text - complete result text.
   */
  commandResult(messageId: string, line: string, text: string): Promise<void>
  /**
   * Report foreground activity; a protocol without foreground states ignores it.
   * @param state - the new foreground state.
   */
  state(state: ForegroundState): Promise<void>
}

/**
 * Build stable-v1 delivery for one session.
 * @param ctx - attachment and usage services.
 * @param sessionId - session addressed by every notification.
 * @param notify - ordered transport write that contains its own failure.
 * @returns v1 delivery; prompt completion travels in the prompt response.
 */
export function v1Output(
  ctx: Context,
  sessionId: SessionId,
  notify: (notification: SessionNotification) => Promise<void>,
): AcpOutput {
  const cursor = new AcpToolCursor()
  const send = (update: SessionNotification['update']): Promise<void> => notify({ sessionId, update })
  return {
    async event(session, event, replay) {
      for (const update of await eventUpdates(ctx, session, event, replay, cursor)) await send(update)
    },
    toolOutput: () => Promise.resolve(),
    plan: entries => send({ sessionUpdate: 'plan', entries: [...entries] }),
    configOptions: options => send({ sessionUpdate: 'config_option_update', configOptions: [...options] }),
    commands: commands => send({ sessionUpdate: 'available_commands_update', availableCommands: [...commands] }),
    // V1 clients may fold every text chunk into one answer regardless of message id;
    // the trailing newline keeps a status line separate from adjacent text.
    status: (messageId, text) => send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: `${text}\n` } }),
    commandResult: (messageId, _line, text) => send({
      sessionUpdate: 'agent_message_chunk', messageId: `${messageId}:result`, content: { type: 'text', text },
    }),
    state: () => Promise.resolve(),
  }
}
