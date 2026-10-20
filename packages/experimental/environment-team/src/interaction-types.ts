/** Destination-scoped conversation controls and terminal streams. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { FileUploadValue, FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { TerminalFrame, TerminalCreateRequest, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { EnvironmentSessionFollowRequest } from './session-types.ts'

type EnvironmentId = Branded<'EnvironmentId'>

/** Viewer-generated identity of one physical terminal connection; it routes only that viewer's input commands. */
export type EnvironmentTerminalAttachmentId = Branded<'EnvironmentTerminalAttachmentId'>

/** Gateway-owned pending interaction identity, never inferred from a tool call. */
export type EnvironmentInteractionId = Branded<'RemoteEventId'>

/** One currently answerable request on the owning Agent. */
export type EnvironmentPendingInteraction =
  | { readonly kind: 'approval'; readonly id: EnvironmentInteractionId; readonly toolName: string; readonly reason?: string; readonly callId?: ToolCallId }
  | { readonly kind: 'questions'; readonly id: EnvironmentInteractionId; readonly questions: readonly AskUserQuestionItem[] }

/** A file or image referenced by the destination's committed Session. */
export interface EnvironmentSessionAttachment {
  readonly attachmentId: Branded<'AttachmentId'>
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
}

/** Ordered tool and failure detail from the destination's committed log. */
export interface EnvironmentSessionDetail {
  readonly seq: number
  readonly kind: 'tool-call' | 'tool-result' | 'error'
  readonly title: string
  readonly text: string
  readonly callId?: ToolCallId
  readonly isError: boolean
}

/** An explicitly addressed operation; no request accepts a filesystem path. */
export type EnvironmentInteractionRequest = EnvironmentSessionFollowRequest & (
  | { readonly action: 'snapshot' }
  | { readonly action: 'upload'; readonly data: string; readonly name: string }
  | { readonly action: 'download'; readonly attachmentId: EnvironmentSessionAttachment['attachmentId'] }
  | { readonly action: 'approval'; readonly id: EnvironmentInteractionId; readonly decision: 'allowed-once' | 'rejected' }
  | { readonly action: 'answer'; readonly id: EnvironmentInteractionId; readonly answer: AskUserQuestionAnswer }
  | { readonly action: 'terminal-create'; readonly request: TerminalCreateRequest }
  | { readonly action: 'terminal-write'; readonly terminalId: WebTerminalId; readonly attachmentId: EnvironmentTerminalAttachmentId; readonly data: string }
  | { readonly action: 'terminal-resize'; readonly terminalId: WebTerminalId; readonly attachmentId: EnvironmentTerminalAttachmentId; readonly cols: number; readonly rows: number }
  | { readonly action: 'terminal-close'; readonly terminalId: WebTerminalId }
)

/** Every result keeps its owning environment, workspace and Session. */
export type EnvironmentInteractionResult = EnvironmentSessionFollowRequest & { readonly environmentId: EnvironmentId } & (
  | { readonly kind: 'snapshot'; readonly pending: readonly EnvironmentPendingInteraction[]; readonly attachments: readonly EnvironmentSessionAttachment[]; readonly details: readonly EnvironmentSessionDetail[]; readonly terminals: readonly WebTerminalInfo[]; readonly capabilities: { readonly attachments: boolean; readonly approvals: boolean; readonly terminals: boolean }; readonly maxUploadBytes: number; readonly terminalCols: number; readonly terminalRows: number; readonly truncated: boolean }
  | { readonly kind: 'uploaded'; readonly upload: FileUploadValue }
  | { readonly kind: 'download'; readonly attachment: EnvironmentSessionAttachment; readonly data: string }
  | { readonly kind: 'terminal'; readonly terminal: WebTerminalInfo }
  | { readonly kind: 'acknowledged' }
)

/** A fresh input attachment is required for each physical terminal connection. */
export interface EnvironmentTerminalFollowRequest extends EnvironmentSessionFollowRequest {
  readonly terminalId: WebTerminalId
  readonly attachmentId: EnvironmentTerminalAttachmentId
}

/** Destination terminal frames forwarded to a viewer; input acknowledgements settle the originating command instead. */
export type EnvironmentTerminalOutput =
  | Omit<Extract<TerminalFrame, { type: 'snapshot' }>, 'inputWindow'>
  | Extract<TerminalFrame, { type: 'output' | 'state' }>

/** Ordered terminal output; unlike conversation snapshots, output cannot be coalesced. */
export interface EnvironmentTerminalFrame extends EnvironmentSessionFollowRequest {
  readonly environmentId: EnvironmentId
  readonly terminalId: WebTerminalId
  readonly frame: EnvironmentTerminalOutput
}

/** Destination-issued file receipts retained until prompt acceptance. */
export type EnvironmentFileReceipt = FileUploadReceiptId
