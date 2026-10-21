/** Invitation lifecycle recovery, retention, and refusal paths of both pairing sides. */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { descriptorSchema, environmentIdSchema } from '../src/protocol.ts'
import { EnvironmentPairing, PAIRING_REDEEM_PATH, boundedPairingJson } from '../src/pairing-core.ts'
import { pairingGrantsSchema } from '../src/pairing-protocol.ts'
import type { PairingGrants, PairingInvitationId } from '../src/pairing-types.ts'
import { PeerTransport } from '../src/transport.ts'
import { pairingHost } from './pairing-host.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const grants: PairingGrants = {
  workspaces: ['project'], workspaceManagement: true, sessionAccess: true,
  attachmentAccess: false, approvalAccess: false, terminalAccess: false, teamAccess: true, teamOperate: false,
}
const host = () => pairingHost((close) => { closes.push(close) })
const invitationId = () => brandString<PairingInvitationId>(randomUUID())
async function pair() {
  const issuer = await host()
  const target = await host()
  const invitation = await issuer.controller.pairingCreate(grants)
  return { issuer, target, invitation }
}
type Host = Awaited<ReturnType<typeof host>>
function attemptOf(side: Host, id: PairingInvitationId) {
  const attempt = side.domain.table('attempts').get(id)
  if (!attempt) throw new Error('Missing attempt')
  return attempt
}
/** Replace only the redemption response, leaving descriptor discovery on the real network. */
function redemptionResponse(issuer: Host, respond: () => Promise<Response>) {
  const actual = globalThis.fetch
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => input === issuer.url + PAIRING_REDEEM_PATH ? respond() : actual(input, init))
}

it('requires team access before team operation can be granted', () => {
  expect(pairingGrantsSchema.safeParse({ ...grants, teamAccess: false, teamOperate: true }).success).toBe(false)
  expect(pairingGrantsSchema.safeParse({ ...grants, teamAccess: true, teamOperate: true }).success).toBe(true)
})

it('refuses to issue invitations without a route, within a byte limit, or for foreign storage', async () => {
  const issuer = await host()
  const original = await issuer.controller.read()
  await issuer.controller.save({ ...original, config: { ...original.config, maxBytes: 100 } })
  await expect(issuer.controller.pairingCreate(grants)).rejects.toThrow('byte limit')
  const small = await issuer.controller.read()
  await issuer.controller.save({ ...small, config: { ...small.config, maxBytes: original.config.maxBytes, publicUrl: '' } })
  await expect(issuer.controller.pairingCreate(grants)).rejects.toThrow('public URL')
  const foreign = new EnvironmentPairing(issuer.ctx, environmentIdSchema.parse(randomUUID()), issuer.domain)
  await expect(foreign.create(grants)).rejects.toThrow('belongs to another installation')
})

it('rejects every operation after the provider is disposed', async () => {
  const issuer = await host()
  const pairing = issuer.ctx.environmentPairing
  await (await issuer.mounted).dispose()
  await expect(pairing.create(grants)).rejects.toThrow('Pairing service is closed')
  await expect(pairing.list()).rejects.toThrow('Pairing service is closed')
})

it('reports unknown invitation and attempt identities', async () => {
  const issuer = await host()
  await expect(issuer.controller.pairingRevoke(invitationId())).rejects.toThrow('invitation not found')
  await expect(issuer.controller.pairingForget(invitationId())).rejects.toThrow('attempt not found')
})

it('lists an invitation that is committing its peer as redeeming', async () => {
  const { issuer, invitation } = await pair()
  const table = issuer.domain.table('invitations')
  const record = table.get(invitation.id)
  if (!record) throw new Error('Missing invitation')
  await table.put(invitation.id, { ...record, status: 'committing' })
  expect(await issuer.controller.pairingList()).toEqual([expect.objectContaining({ id: invitation.id, status: 'redeeming' })])
})

it('refuses to pair an installation with itself, an already paired peer, or a changed peer route', async () => {
  const { issuer, target, invitation } = await pair()
  await expect(issuer.controller.pairingAccept(invitation, grants)).rejects.toThrow('cannot pair with itself')
  await target.controller.pairingAccept(invitation, grants)
  const second = await issuer.controller.pairingCreate(grants)
  await expect(target.controller.pairingAccept(second, grants)).rejects.toThrow('Remove the existing peer')
  const current = await target.controller.read()
  const peer = current.config.peers[0]
  if (!peer) throw new Error('Missing paired issuer')
  await target.controller.save({ ...current, config: { ...current.config, peers: [{ ...peer, url: 'http://127.0.0.1:9' }] } })
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('changed the peer route')
})

it('discards its staged credential when the attempt cannot be recorded', async () => {
  const { target, invitation } = await pair()
  const set = vi.spyOn(target.ctx.credentials, 'set')
  const unset = vi.spyOn(target.ctx.credentials, 'unset')
  vi.spyOn(target.domain.table('attempts'), 'put').mockRejectedValueOnce(new Error('attempt store full'))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('attempt store full')
  expect(set).toHaveBeenCalledTimes(1)
  expect(unset).toHaveBeenCalledWith(set.mock.calls[0]?.[0])
  expect(await target.controller.pairingAttempts()).toEqual([])
})

it('refuses a retry whose staged credential disappeared', async () => {
  const { issuer, target, invitation } = await pair()
  const offline = redemptionResponse(issuer, () => Promise.reject(new Error('issuer offline')))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('issuer offline')
  offline.mockRestore()
  await target.ctx.credentials.unset(credentialRef(attemptOf(target, invitation.id).credentialRef))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('Staged pairing credential is unavailable or changed')
})

it('rejects a pairing request larger than the configured byte limit', async () => {
  const { target, invitation } = await pair()
  vi.spyOn(PeerTransport.prototype, 'describe').mockResolvedValue(descriptorSchema.parse({ environmentId: invitation.issuer.environmentId, label: 'issuer', platform: 'test', protocol: 1, capabilities: { distributedTeams: true } }))
  const fetch = vi.spyOn(globalThis, 'fetch')
  const current = await target.controller.read()
  await target.controller.save({ ...current, config: { ...current.config, maxBytes: 100 } })
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('request byte limit')
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects an acknowledgment that names different installations', async () => {
  const { issuer, target, invitation } = await pair()
  redemptionResponse(issuer, async () => Response.json({ environmentId: randomUUID(), peerId: randomUUID(), invitationId: invitation.id }))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('acknowledgment identity mismatch')
  expect((await target.controller.read()).config.peers).toEqual([])
  expect(await target.controller.pairingAttempts()).toEqual([expect.objectContaining({ status: 'pending' })])
})

it('finishes an issuer commit that stopped before its consumed record was written', async () => {
  const { issuer, target, invitation } = await pair()
  const table = issuer.domain.table('invitations')
  const put = table.put.bind(table)
  vi.spyOn(table, 'put').mockImplementation((id, value) => value.status === 'consumed'
    ? Promise.reject(new Error('receipt persistence failed')) : put(id, value))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('refused')
  expect(await issuer.controller.pairingList()).toEqual([expect.objectContaining({ status: 'redeeming' })])
  vi.restoreAllMocks()
  await target.controller.pairingAccept(invitation, grants)
  expect(await issuer.controller.pairingList()).toEqual([expect.objectContaining({ status: 'consumed' })])
  expect((await target.controller.read()).config.peers).toHaveLength(1)
})

it('resumes an issuer redemption whose credential write failed using the same staged reference', async () => {
  const { issuer, target, invitation } = await pair()
  const set = vi.spyOn(issuer.ctx.credentials, 'set').mockRejectedValueOnce(new Error('credential store offline'))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('refused')
  expect(await issuer.controller.pairingList()).toEqual([expect.objectContaining({ status: 'redeeming' })])
  await target.controller.pairingAccept(invitation, grants)
  expect(set).toHaveBeenCalledTimes(2)
  expect(set.mock.calls[1]?.[0]).toEqual(set.mock.calls[0]?.[0])
  expect(await issuer.controller.pairingList()).toEqual([expect.objectContaining({ status: 'consumed' })])
})

it('finishes an outgoing commit that stopped before its complete record was written', async () => {
  const { target, invitation } = await pair()
  const table = target.domain.table('attempts')
  const put = table.put.bind(table)
  vi.spyOn(table, 'put').mockImplementation((id, value) => value.status === 'complete'
    ? Promise.reject(new Error('receipt persistence failed')) : put(id, value))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('receipt persistence failed')
  expect(await target.controller.pairingAttempts()).toEqual([expect.objectContaining({ status: 'committing' })])
  vi.restoreAllMocks()
  await target.controller.pairingAccept(invitation, grants)
  expect(await target.controller.pairingAttempts()).toEqual([expect.objectContaining({ status: 'complete' })])
})

it('keeps an already configured peer when a rolled back attempt is accepted again', async () => {
  const { target, invitation } = await pair()
  await target.controller.pairingAccept(invitation, grants)
  const before = await target.controller.read()
  await target.domain.table('attempts').put(invitation.id, { ...attemptOf(target, invitation.id), status: 'pending' })
  await target.controller.pairingAccept(invitation, grants)
  expect(await target.controller.read()).toEqual(before)
  expect(await target.controller.pairingAttempts()).toEqual([expect.objectContaining({ status: 'complete' })])
})

it('refuses a redemption that names the issuer as the redeeming installation', async () => {
  const { issuer, invitation } = await pair()
  const redeem = { invitationId: invitation.id, token: invitation.token, target: invitation.issuer, secret: randomBytes(32).toString('base64url') }
  await expect(issuer.ctx.environmentPairing.redeem(redeem)).rejects.toThrow('cannot pair with itself')
})

it('drops expired invitations and completed attempts when new work needs their capacity', async () => {
  const { issuer, target, invitation } = await pair()
  await target.controller.pairingAccept(invitation, grants)
  expect(await target.controller.pairingAttempts()).toHaveLength(1)
  await target.controller.pairingCreate(grants)
  expect(await target.controller.pairingAttempts()).toHaveLength(1)
  const stale = await issuer.controller.pairingCreate(grants)
  vi.spyOn(Date, 'now').mockReturnValue(stale.expiresAt + 1)
  const fresh = await issuer.controller.pairingCreate(grants)
  expect((await issuer.controller.pairingList()).map(item => item.id)).toEqual([fresh.id])
  await target.controller.pairingCreate(grants)
  expect(await target.controller.pairingAttempts()).toEqual([])
})

it('requires a bounded response body from the issuer', async () => {
  await expect(boundedPairingJson(new Response(null), 10)).rejects.toThrow('no body')
  await expect(boundedPairingJson(new Response('{"padding":"too long"}'), 10)).rejects.toThrow('byte limit')
  await expect(boundedPairingJson(new Response('{"ok":true}'), 100)).resolves.toEqual({ ok: true })
})
