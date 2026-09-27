/** Pairing persistence retains invitation hashes and credential references, never invitation or pairing secrets. */
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { environmentIdSchema } from './protocol.ts'
import { pairingIdSchema, pairingTargetSchema, pairingGrantsSchema } from './pairing-protocol.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
/** Validated durable invitation and recoverable outgoing attempt records. */
export const pairingDomain = defineDomain({
  name: 'environment_pairing', version: 1, layout: 'per-record',
  global: { schema: z.object({ environmentId: environmentIdSchema.nullable() }), initial: { environmentId: null } },
  tables: {
    invitations: { valueSchema: z.object({
      id: pairingIdSchema, target: pairingTargetSchema.optional(), grants: pairingGrantsSchema,
      createdAt: z.number().int(), expiresAt: z.number().int(), tokenHash: digest,
      status: z.enum(['pending', 'redeeming', 'committing', 'consumed', 'revoked']),
      redemption: z.object({ fingerprint: digest, credentialRef: z.string().min(1) }).strict().optional(),
    }).strict() },
    attempts: { valueSchema: z.object({
      id: pairingIdSchema, issuer: pairingTargetSchema, target: pairingTargetSchema,
      fingerprint: digest, secretHash: digest, credentialRef: z.string().min(1), grants: pairingGrantsSchema,
      expiresAt: z.number().int(), status: z.enum(['pending', 'committing', 'complete']),
    }).strict() },
  },
})
