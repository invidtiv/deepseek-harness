/** Strict peer JSON validation for workspace-scoped Session operations. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EnvironmentSessionFollowRequest, EnvironmentSessionFrame, SessionRequest, SessionResult } from './session-types.ts'

const workspaceId = z.string().min(1).transform(value => brandString<SessionRequest['workspaceId']>(value))
const sessionId = z.string().min(1).transform(value => brandString<Exclude<SessionRequest, { action: 'list' }>['sessionId']>(value))
const requestId = z.string().min(1).transform(value => brandString<Extract<SessionRequest, { action: 'prompt' }>['requestId']>(value))
const environmentId = z.uuid().transform(value => brandString<SessionResult['environmentId']>(value))

/** Accepted peer commands, with retry identities required before mutation admission. */
export const sessionRequestSchema: z.ZodType<SessionRequest> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), workspaceId }).strict(),
  z.object({ action: z.literal('create'), workspaceId, sessionId }).strict(),
  z.object({ action: z.literal('read'), workspaceId, sessionId }).strict(),
  z.object({ action: z.literal('cancel'), workspaceId, sessionId }).strict(),
  z.object({ action: z.literal('prompt'), workspaceId, sessionId, requestId, text: z.string().refine(value => value.trim().length > 0), attachments: z.array(z.string().min(1).transform(value => brandString<NonNullable<Extract<SessionRequest, { action: 'prompt' }>['attachments']>[number]>(value))).optional(), images: z.array(z.object({ data: z.string(), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), name: z.string().optional() }).strict()).optional() }).strict(),
])

const scope = { environmentId, workspaceId }
const snapshot = z.object({ ...scope, kind: z.literal('snapshot'), sessionId, cursor: z.number().int().min(-1), running: z.boolean(), messages: z.array(z.object({ seq: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']), text: z.string() }).strict()), truncated: z.boolean() }).strict()
/** Validated workspace-scoped subscription address. */
export const sessionFollowRequestSchema: z.ZodType<EnvironmentSessionFollowRequest> = z.object({ workspaceId, sessionId }).strict()
/** Sanitized full replacement frame accepted across the peer wire. */
export const environmentSessionFrameSchema: z.ZodType<EnvironmentSessionFrame> = snapshot.extend({ live: z.object({ attemptId: z.string().min(1).transform(value => brandString<NonNullable<EnvironmentSessionFrame['live']>['attemptId']>(value)), text: z.string() }).strict().optional() })
/** Accepted destination responses, without open JSON objects or unchecked event payloads. */
export const sessionResultSchema: z.ZodType<SessionResult> = z.discriminatedUnion('kind', [
  z.object({ ...scope, kind: z.literal('sessions'), sessions: z.array(z.object({ sessionId, title: z.string(), running: z.boolean(), updatedAt: z.number() }).strict()), truncated: z.boolean() }).strict(),
  ...(['created', 'accepted', 'cancelled'] as const).map(kind => z.object({ ...scope, kind: z.literal(kind), sessionId }).strict()),
  snapshot,
])
