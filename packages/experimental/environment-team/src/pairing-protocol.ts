/** Strict invitation and redemption JSON validation. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { environmentIdSchema } from './protocol.ts'
import { environmentUrlSchema } from './config.ts'
import type { PairingInvitationId } from './pairing-types.ts'

/** Parse an opaque invitation identity. */
export const pairingIdSchema = z.uuid().transform(value => brandString<PairingInvitationId>(value))
/** Pin the route independently from durable installation identity. */
export const pairingTargetSchema = z.object({ environmentId: environmentIdSchema, url: environmentUrlSchema }).strict()
/** Explicit, non-inherited peer grants. */
export const pairingGrantsSchema = z.object({
  workspaces: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)),
  attachmentAccess: z.boolean(), approvalAccess: z.boolean(), terminalAccess: z.boolean(),
  workspaceManagement: z.boolean(), sessionAccess: z.boolean(), teamAccess: z.boolean(), teamOperate: z.boolean(),
}).strict().refine(value => !value.teamOperate || value.teamAccess, 'Team operation requires team access')
/** Invitation secret is read once by its creator and submitted only to its pinned issuer. */
export const pairingInvitationSchema = z.object({
  id: pairingIdSchema, issuer: pairingTargetSchema, target: pairingTargetSchema,
  expiresAt: z.number().int().positive(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict()
/** Redeemer supplies the shared credential so the issuer never returns a recoverable secret. */
export const pairingRedemptionSchema = z.object({
  invitationId: pairingIdSchema, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  target: pairingTargetSchema, secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict()
/** Identity-pinned acknowledgment of the issuer's durable peer configuration. */
export const pairingReceiptSchema = z.object({
  environmentId: environmentIdSchema, peerId: environmentIdSchema, invitationId: pairingIdSchema,
}).strict()
/** Write-only credential changes bound to configured peer identities. */
export const pairingCredentialChangesSchema = z.array(z.object({
  environmentId: environmentIdSchema, secret: z.string().min(32),
}).strict())
