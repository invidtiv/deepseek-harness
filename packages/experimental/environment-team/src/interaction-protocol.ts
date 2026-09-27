/** Strict JSON validation for environment-owned conversation controls. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EnvironmentInteractionRequest, EnvironmentInteractionResult, EnvironmentPendingInteraction, EnvironmentTerminalFollowRequest, EnvironmentTerminalFrame } from './interaction-types.ts'
const environmentIdSchema = z.uuid().transform(value => brandString<EnvironmentInteractionResult['environmentId']>(value))

function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> }
}

const scope = z.object({ workspaceId: z.string().min(1).transform(value => brandString<EnvironmentInteractionRequest['workspaceId']>(value)), sessionId: z.string().min(1).transform(value => brandString<EnvironmentInteractionRequest['sessionId']>(value)) })
const terminalId = z.string().regex(/^[\w-]{1,128}$/u).transform(value => brandString<EnvironmentTerminalFollowRequest['terminalId']>(value))
const attachmentId = z.string().min(1).transform(value => brandString<EnvironmentTerminalFollowRequest['attachmentId']>(value))
const eventId = z.string().min(1).transform(value => brandString<EnvironmentPendingInteraction['id']>(value))
const fileId = z.string().min(1).transform(value => brandString<Extract<EnvironmentInteractionRequest, { action: 'download' }>['attachmentId']>(value))
const callId = z.string().min(1).transform(value => brandString<NonNullable<Extract<EnvironmentPendingInteraction, { kind: 'approval' }>['callId']>>(value))
const dimension = z.number().int().positive()
const answer = z.object({
  answers: z.array(z.object({
    id: z.string(), selected: z.array(z.string()), custom: z.string().optional(),
  }).strict().transform(defined)),
}).strict()
const question = z.object({ id: z.string(), question: z.string(), detail: z.string().optional(), header: z.string().optional(), options: z.array(z.object({ label: z.string(), description: z.string().optional() }).strict().transform(defined)).optional(), multiSelect: z.boolean().optional(), intent: z.object({ kind: z.literal('plan-review'), approve: z.string(), callId: callId.optional() }).strict().transform(defined).optional() }).strict().transform(defined)
const terminalInfo = z.object({ id: terminalId, title: z.string(), shell: z.object({ path: z.string(), args: z.array(z.string()), name: z.string() }).strict(), cwd: z.string(), cols: dimension, rows: dimension, state: z.enum(['running', 'exited', 'failed']), exitCode: z.number().int().nullable(), error: z.string().optional(), controllerId: attachmentId.optional() }).strict().transform(defined)
const terminalCreate = z.object({
  id: terminalId, cols: dimension, rows: dimension, shellPath: z.string().optional() }).strict().transform(defined)
const attachment = z.object({
  attachmentId: fileId, name: z.string(), bytes: z.number().int().nonnegative(), mediaType: z.string() }).strict()

/** Requests accepted after authenticating the calling environment. */
export const interactionRequestSchema: z.ZodType<EnvironmentInteractionRequest> = z.discriminatedUnion('action', [
  scope.extend({ action: z.literal('snapshot') }).strict(),
  scope.extend({ action: z.literal('upload'), data: z.string(), name: z.string() }).strict(),
  scope.extend({ action: z.literal('download'), attachmentId: fileId }).strict(),
  scope.extend({ action: z.literal('approval'), id: eventId, decision: z.enum(['allowed-once', 'rejected']) }).strict(),
  scope.extend({ action: z.literal('answer'), id: eventId, answer }).strict(),
  scope.extend({ action: z.literal('terminal-create'), request: terminalCreate }).strict(),
  scope.extend({ action: z.literal('terminal-write'), terminalId, attachmentId, data: z.string() }).strict(),
  scope.extend({ action: z.literal('terminal-resize'), terminalId, attachmentId, cols: dimension, rows: dimension }).strict(),
  scope.extend({ action: z.literal('terminal-close'), terminalId }).strict(),
])

/** Pending requests are projected from the gateway's shared settlement broker. */
export const pendingInteractionSchema: z.ZodType<EnvironmentPendingInteraction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), id: eventId, toolName: z.string(), reason: z.string().optional(), callId: callId.optional() }).strict(),
  z.object({ kind: z.literal('questions'), id: eventId, questions: z.array(question) }).strict(),
]).transform(defined)

const resultScope = scope.extend({ environmentId: environmentIdSchema })
/** Complete validated destination results, including limits visible to the client. */
export const interactionResultSchema: z.ZodType<EnvironmentInteractionResult> = z.discriminatedUnion('kind', [
  resultScope.extend({ kind: z.literal('snapshot'), pending: z.array(pendingInteractionSchema), attachments: z.array(attachment), details: z.array(z.object({ seq: z.number().int().nonnegative(), kind: z.enum(['tool-call', 'tool-result', 'error']), title: z.string(), text: z.string(), callId: callId.optional(), isError: z.boolean() }).strict().transform(defined)), terminals: z.array(terminalInfo), capabilities: z.object({ attachments: z.boolean(), approvals: z.boolean(), terminals: z.boolean() }).strict(), maxUploadBytes: z.number().int().nonnegative(), terminalCols: dimension, terminalRows: dimension, truncated: z.boolean() }).strict(),
  resultScope.extend({ kind: z.literal('uploaded'), upload: z.object({ receiptId: z.string().min(1).transform(value => brandString<Extract<EnvironmentInteractionResult, { kind: 'uploaded' }>['upload']['receiptId']>(value)), file: z.object({ attachmentId: fileId, name: z.string(), bytes: z.number().int().nonnegative() }).strict() }).strict() }).strict(),
  resultScope.extend({ kind: z.literal('download'), attachment, data: z.string() }).strict(),
  resultScope.extend({ kind: z.literal('terminal'), terminal: terminalInfo }).strict(),
  resultScope.extend({ kind: z.literal('acknowledged') }).strict(),
])

/** Address of one physical terminal connection. */
export const terminalFollowRequestSchema: z.ZodType<EnvironmentTerminalFollowRequest> = scope.extend({ terminalId, attachmentId }).strict()
/** Ordered output frame with explicit destination identity. */
export const environmentTerminalFrameSchema: z.ZodType<EnvironmentTerminalFrame> = resultScope.extend({ terminalId, frame: z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), sequence: z.number().int().nonnegative(), screen: z.string(), info: terminalInfo }).strict(),
  z.object({ type: z.literal('output'), sequence: z.number().int().nonnegative(), data: z.string() }).strict(),
  z.object({ type: z.literal('state'), info: terminalInfo }).strict(),
]) }).strict()
