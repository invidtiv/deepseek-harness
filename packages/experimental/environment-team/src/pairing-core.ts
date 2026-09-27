/** Identity-pinned invitation redemption with durable retry receipts and compensated profile commits. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { pairingDomain } from './pairing-store.ts'
import { pairingGrantsSchema, pairingTargetSchema, pairingIdSchema, pairingInvitationSchema, pairingRedemptionSchema, pairingReceiptSchema } from './pairing-protocol.ts'
import { readEnvironmentConfiguration, saveEnvironmentConfiguration } from './pairing-configuration.ts'
import { PeerTransport } from './transport.ts'
import type { EnvironmentId } from './protocol.ts'
import { resolveConfig, type ResolvedConfig } from './config.ts'
import type { EnvironmentConfiguration } from './settings-types.ts'
import type { PairingTarget, PairingGrants, PairingInvitation, PairingInvitationMetadata, PairingInvitationId, PairingReceipt, PairingAttemptMetadata } from './pairing-types.ts'

/** Public invitation exchange endpoint; its body carries the one-time authorization. */
export const PAIRING_REDEEM_PATH = '/dsh/environment-team/pairing/redeem'
/** Authenticated peer identity check without filesystem or Session authority. */
export const PAIRING_STATUS_PATH = '/dsh/environment-team/pairing/status'

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function sameHash(left: string, right: string): boolean { return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex')) }
function reference(): string { return `DSH_PAIR_${randomUUID().replaceAll('-', '_')}` }

/** Service-owned invitation state survives reloads of the execution runtime. */
export class EnvironmentPairing {
  private readonly abort = new AbortController()
  private tail = Promise.resolve()
  constructor(
    private readonly ctx: Context, readonly environmentId: EnvironmentId, private readonly domain: Domain<typeof pairingDomain>,
  ) {}

  /** Issue a secret once for one intended peer and one explicit grant.
   * @param target - intended peer identity and route.
   * @param grants - local permissions delegated by this invitation.
   * @returns private invitation envelope; subsequent reads expose metadata only.
   */
  create(target: PairingTarget, grants: PairingGrants): Promise<PairingInvitation> {
    return this.serial(async () => {
      const current = await this.configuration()
      const issuer = this.origin(current)
      const parsed = pairingTargetSchema.parse(target)
      const grant = this.grants(current.config, grants)
      this.available(current, parsed)
      await this.prune(current.config.maxInvitations)
      await this.describe(current, parsed)
      const id = pairingIdSchema.parse(randomUUID())
      const token = randomBytes(32).toString('base64url')
      const createdAt = Date.now()
      const expiresAt = createdAt + current.config.invitationLifetimeMs
      const record = { id, target: parsed, grants: grant, createdAt, expiresAt, tokenHash: hash(token), status: 'pending' as const }
      if (Buffer.byteLength(JSON.stringify(record)) > current.config.maxBytes) throw new Error('Pairing invitation byte limit reached')
      await this.domain.table('invitations').put(id, record)
      return { id, issuer, target: parsed, expiresAt, token }
    })
  }

  /** Read metadata without recovering invitation tokens or pair credentials.
   * @returns retained invitation metadata and computed expiration status.
   */
  list(): Promise<PairingInvitationMetadata[]> {
    return this.serial(() => Promise.resolve([...this.domain.table('invitations').entries()].map(([, { id, target, grants, createdAt, expiresAt, status }]) => ({
      id, target, grants, createdAt, expiresAt, status: status === 'committing' ? 'redeeming' : status === 'pending' && expiresAt <= Date.now() ? 'expired' : status,
    }))))
  }

  /** Revoke an invitation without disconnecting an already paired machine.
   * @param id - invitation selected in the operator's metadata list.
   */
  revoke(id: PairingInvitationId): Promise<void> {
    return this.serial(async () => {
      const parsed = pairingIdSchema.parse(id)
      const item = this.domain.table('invitations').get(parsed)
      if (!item) throw new Error('Pairing invitation not found')
      if (item.status === 'consumed') throw new Error('Remove the configured peer to revoke an existing pairing')
      await this.domain.table('invitations').put(parsed, { ...item, status: 'revoked' })
    })
  }

  /** Admit a token-authorized redemption; exact retries reuse its immutable credential reference.
   * @param input - untrusted public exchange body.
   * @returns public identity acknowledgment after the issuer has committed its peer configuration.
   */
  redeem(input: unknown): Promise<PairingReceipt> {
    return this.serial(async () => {
      const request = pairingRedemptionSchema.parse(input)
      const current = await this.configuration()
      const item = this.domain.table('invitations').get(request.invitationId)
      if (!item || !sameHash(item.tokenHash, hash(request.token)) || item.status === 'revoked') throw new Error('Pairing invitation is unavailable')
      if (item.target.environmentId !== request.target.environmentId || item.target.url !== request.target.url) throw new Error('Pairing destination mismatch')
      const fingerprint = hash(JSON.stringify(request))
      if (item.redemption && !sameHash(item.redemption.fingerprint, fingerprint)) throw new Error('Pairing invitation was already redeemed')
      if (!item.redemption && item.expiresAt <= Date.now()) throw new Error('Pairing invitation expired')
      const staged = item.redemption?.credentialRef ?? reference()
      this.available(current, item.target, staged)
      if (item.status === 'consumed' || item.status === 'committing') {
        const peer = current.config.peers.find(candidate => candidate.environmentId === item.target.environmentId)
        const stored = (await this.ctx.credentials.resolve(credentialRef(staged)))?.value
        if (!peer || !stored || !sameHash(hash(stored), hash(request.secret))) throw new Error('Pairing has been revoked or rotated')
        if (item.status === 'committing') await this.domain.table('invitations').put(item.id, { ...item, status: 'consumed' })
        return { environmentId: this.environmentId, peerId: item.target.environmentId, invitationId: item.id }
      }
      this.grants(current.config, item.grants)
      await this.describe(current, item.target)
      if (!item.redemption) await this.domain.table('invitations').put(item.id, {
        ...item, status: 'redeeming', redemption: { fingerprint, credentialRef: staged },
      })
      await this.ctx.credentials.set(credentialRef(staged), request.secret)
      await this.domain.table('invitations').put(item.id, { ...item, status: 'committing', redemption: { fingerprint, credentialRef: staged } })
      await this.commit(current, item.target, item.grants, staged)
      await this.domain.table('invitations').put(item.id, { ...item, status: 'consumed', redemption: { fingerprint, credentialRef: staged } })
      return { environmentId: this.environmentId, peerId: item.target.environmentId, invitationId: item.id }
    })
  }

  /** Redeem a private invitation and grant the issuer explicitly selected local access.
   * @param invitation - pinned issuer, intended destination, and one-time token.
   * @param grants - this installation's permissions granted to the issuer.
   * @returns acknowledgment after both installation configurations are committed.
   */
  accept(invitation: unknown, grants: PairingGrants): Promise<PairingReceipt> {
    return this.serial(async () => {
      const invite = pairingInvitationSchema.parse(invitation)
      const current = await this.configuration()
      const local = this.origin(current)
      if (invite.target.environmentId !== local.environmentId || invite.target.url !== local.url) throw new Error('Invitation belongs to another installation or route')
      const grant = this.grants(current.config, grants)
      const fingerprint = hash(JSON.stringify({ invitation: invite, grants: grant }))
      let attempt = this.domain.table('attempts').get(invite.id)
      if (attempt && !sameHash(attempt.fingerprint, fingerprint)) throw new Error('Pairing retry changed its invitation or grants')
      this.available(current, invite.issuer, attempt?.credentialRef)
      if (attempt?.status === 'complete' || attempt?.status === 'committing') {
        if (!current.config.peers.some(peer => peer.environmentId === invite.issuer.environmentId)) throw new Error('Pairing has been removed')
        const credential = (await this.ctx.credentials.resolve(credentialRef(attempt.credentialRef)))?.value
        if (!credential || !sameHash(hash(credential), attempt.secretHash)) throw new Error('Pairing credential has been revoked or rotated')
        if (attempt.status === 'committing') await this.domain.table('attempts').put(invite.id, { ...attempt, status: 'complete' })
        return { environmentId: invite.issuer.environmentId, peerId: local.environmentId, invitationId: invite.id }
      }
      await this.describe(current, invite.issuer)
      if (!attempt) {
        if (invite.expiresAt <= Date.now()) throw new Error('Pairing invitation expired')
        await this.prune(current.config.maxInvitations)
        const staged = reference()
        const secret = randomBytes(32).toString('base64url')
        await this.ctx.credentials.set(credentialRef(staged), secret)
        attempt = { id: invite.id, issuer: invite.issuer, target: local, fingerprint, secretHash: hash(secret), credentialRef: staged, grants: grant, expiresAt: invite.expiresAt, status: 'pending' }
        try { await this.domain.table('attempts').put(invite.id, attempt) } catch (error) {
          await this.ctx.credentials.unset(credentialRef(staged))
          throw error
        }
      }
      const secret = (await this.ctx.credentials.resolve(credentialRef(attempt.credentialRef)))?.value
      if (!secret || !sameHash(hash(secret), attempt.secretHash)) throw new Error('Staged pairing credential is unavailable or changed')
      const body = JSON.stringify({ invitationId: invite.id, token: invite.token, target: local, secret })
      if (Buffer.byteLength(body) > current.config.maxBytes) throw new Error('Pairing request byte limit reached')
      const response = await fetch(invite.issuer.url + PAIRING_REDEEM_PATH, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body,
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(current.config.requestTimeoutMs)]),
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error('Pairing issuer refused redemption') }
      const receipt = pairingReceiptSchema.parse(await boundedPairingJson(response, current.config.maxBytes))
      if (receipt.environmentId !== invite.issuer.environmentId || receipt.peerId !== local.environmentId || receipt.invitationId !== invite.id) throw new Error('Pairing acknowledgment identity mismatch')
      await this.domain.table('attempts').put(invite.id, { ...attempt, status: 'committing' })
      await this.commit(await this.configuration(), invite.issuer, attempt.grants, attempt.credentialRef)
      await this.domain.table('attempts').put(invite.id, { ...attempt, status: 'complete' })
      return receipt
    })
  }

  /** List recoverable outgoing attempts without credential material.
   * @returns staged and completed invitation acceptances.
   */
  attempts(): Promise<PairingAttemptMetadata[]> {
    return this.serial(() => Promise.resolve([...this.domain.table('attempts').entries()].map(([, { id, issuer, expiresAt, status }]) => ({ id, issuer, expiresAt, status }))))
  }

  /** Discard an unconnected outgoing attempt and its staged secret.
   * @param id - outgoing attempt identity selected by the operator.
   */
  forget(id: PairingInvitationId): Promise<void> {
    return this.serial(async () => {
      const parsed = pairingIdSchema.parse(id)
      const attempt = this.domain.table('attempts').get(parsed)
      if (!attempt) throw new Error('Pairing attempt not found')
      const current = await this.configuration()
      if (current.config.peers.some(peer => peer.tokenEnv === attempt.credentialRef)) throw new Error('Remove the configured peer before discarding its pairing attempt')
      await this.ctx.credentials.unset(credentialRef(attempt.credentialRef))
      await this.domain.table('attempts').delete(parsed)
    })
  }

  /** Stop network work and join admitted state mutations before closing persistence. */
  async close(): Promise<void> { this.abort.abort(); await this.tail; await this.domain.close() }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('Pairing service is closed'))
    const pending = this.tail.then(() => { this.abort.signal.throwIfAborted(); return work() })
    this.tail = pending.then(() => undefined, () => undefined)
    return pending
  }
  private async configuration(): Promise<EnvironmentConfiguration & { config: ResolvedConfig }> {
    const current = await readEnvironmentConfiguration(this.ctx)
    if (current.environmentId !== this.environmentId) throw new Error('Pairing storage belongs to another installation')
    return { ...current, config: resolveConfig(current.config) }
  }
  private origin(current: EnvironmentConfiguration): PairingTarget {
    if (!current.config.publicUrl) throw new Error('Configure the reachable public URL before pairing')
    return { environmentId: this.environmentId, url: current.config.publicUrl }
  }
  private grants(config: EnvironmentConfiguration['config'], input: PairingGrants): PairingGrants {
    const grants = pairingGrantsSchema.parse(input)
    if (new Set(grants.workspaces).size !== grants.workspaces.length || grants.workspaces.some(alias => !config.workspaces[alias])) throw new Error('Pairing grant names an unavailable workspace')
    return grants
  }
  private available(current: EnvironmentConfiguration, target: PairingTarget, staged?: string): void {
    if (target.environmentId === this.environmentId) throw new Error('An installation cannot pair with itself')
    const peer = current.config.peers.find(item => item.environmentId === target.environmentId)
    if (peer && peer.tokenEnv !== staged) throw new Error('Remove the existing peer before creating a new pairing')
    if (peer && peer.url !== target.url) throw new Error('Pairing retry changed the peer route')
  }
  private async describe(current: EnvironmentConfiguration, target: PairingTarget): Promise<void> {
    const config = resolveConfig({ ...current.config, peers: [{ ...target, tokenEnv: 'PAIRING_DISCOVERY', workspaces: [] }] })
    await new PeerTransport(this.environmentId, config, this.ctx.credentials).describe(target.environmentId, this.abort.signal)
  }
  private async commit(current: EnvironmentConfiguration, target: PairingTarget, grants: PairingGrants, staged: string): Promise<void> {
    this.available(current, target, staged)
    if (current.config.peers.some(peer => peer.environmentId === target.environmentId)) return
    await saveEnvironmentConfiguration(this.ctx, {
      ...current, config: { ...current.config, peers: [...current.config.peers, { ...target, ...grants, tokenEnv: staged }] },
    }, [])
  }
  private async prune(limit: number): Promise<void> {
    const invitations = this.domain.table('invitations')
    for (const [id, record] of invitations.entries()) {
      if (record.expiresAt <= Date.now() && record.status !== 'redeeming') await invitations.delete(id)
    }
    const attempts = this.domain.table('attempts')
    for (const [id, record] of attempts.entries()) {
      if (record.expiresAt <= Date.now() && record.status === 'complete') await attempts.delete(id)
    }
    if (invitations.size + attempts.size >= limit) throw new Error('Pairing invitation limit reached')
  }
}

/** Parse a size-bounded peer response before inspecting its fields.
 * @param response - response from the pinned issuer.
 * @param maxBytes - configured complete payload limit.
 * @returns untrusted decoded JSON for schema validation.
 */
export async function boundedPairingJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('Pairing response has no body')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new Error('Pairing response byte limit reached')
      parts.push(next.value)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } finally { await reader.cancel(); reader.releaseLock() }
}
