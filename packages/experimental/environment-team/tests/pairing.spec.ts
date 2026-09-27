/** Invitation identities, durable retry admission, and configuration/credential consistency. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PairingGrants } from '../src/pairing-types.ts'
import { PAIRING_REDEEM_PATH, PAIRING_STATUS_PATH } from '../src/pairing-core.ts'
import { pairingHost } from './pairing-host.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close() })
const grants: PairingGrants = {
  workspaces: ['project'], workspaceManagement: true, sessionAccess: true,
  attachmentAccess: false, approvalAccess: false, terminalAccess: false, teamAccess: true, teamOperate: false,
}
async function pair() {
  const issuer = await pairingHost((close) => { closes.push(close) })
  const target = await pairingHost((close) => { closes.push(close) })
  const invitation = await issuer.controller.pairingCreate(grants)
  return { issuer, target, invitation }
}

it('pairs both installations from one generated code and stores no recoverable invitation secret', async () => {
  const { issuer, target, invitation } = await pair()
  expect(invitation.target).toBeUndefined()
  const metadata = await issuer.controller.pairingList()
  expect(metadata).toEqual([expect.objectContaining({ id: invitation.id, status: 'pending', grants })])
  const pending = metadata[0]
  if (!pending) throw new Error('Missing pending invitation')
  expect(pending.expiresAt - pending.createdAt).toBe(30 * 60 * 1000)
  expect(JSON.stringify(metadata)).not.toContain(invitation.token)
  const code = `dsh-pair:${Buffer.from(JSON.stringify(invitation)).toString('base64url')}`
  const [first, retry] = await Promise.all([
    target.controller.pairingImport(code, grants), target.controller.pairingImport(code, grants),
  ])
  expect(first).toEqual(retry)
  const a = await issuer.controller.read()
  const b = await target.controller.read()
  expect(a.config.peers).toHaveLength(1)
  expect(b.config.peers).toHaveLength(1)
  expect(a.config.peers[0]).toMatchObject({ environmentId: b.environmentId, ...grants })
  expect(b.config.peers[0]).toMatchObject({ environmentId: a.environmentId, ...grants })
  const peer = b.config.peers[0]
  if (!peer) throw new Error('Missing paired issuer')
  const secret = (await target.ctx.credentials.resolve(credentialRef(peer.tokenEnv)))?.value
  expect(secret).toBeTruthy()
  const reciprocal = a.config.peers[0]
  if (!reciprocal) throw new Error('Missing paired client')
  expect((await issuer.ctx.credentials.resolve(credentialRef(reciprocal.tokenEnv)))?.value).toBe(secret)
  const response = await fetch(issuer.url + PAIRING_STATUS_PATH, { headers: { authorization: `Bearer ${secret}` } })
  expect(await response.json()).toEqual({ environmentId: a.environmentId, peerId: b.environmentId })
  expect(await issuer.controller.pairingList()).toEqual([expect.objectContaining({ status: 'consumed', target: { environmentId: b.environmentId, url: target.url } })])
  for (const file of await readdir(join(issuer.home, 'storage'), { recursive: true })) {
    if (file.endsWith('.json')) expect(await readFile(join(issuer.home, 'storage', file), 'utf8')).not.toContain(invitation.token)
  }
  expect(await readFile(issuer.profile.patchPath, 'utf8')).not.toContain(secret)
  await target.controller.save({ ...b, config: { ...b.config, peers: [] } })
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('removed')
})

it('recovers an uncertain exchange using the same staged credential and rejects changed replays', async () => {
  const { issuer, target, invitation } = await pair()
  const actualFetch = globalThis.fetch
  let dropped = false
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await actualFetch(...args)
    if (!dropped && args[0] === issuer.url + PAIRING_REDEEM_PATH) {
      dropped = true
      await response.body?.cancel()
      throw new Error('response lost after commit')
    }
    return response
  })
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('lost after commit')
  expect((await issuer.controller.read()).config.peers).toHaveLength(1)
  expect((await target.controller.read()).config.peers).toHaveLength(0)
  request.mockRestore()
  await target.controller.pairingAccept(invitation, grants)
  const changed = { invitationId: invitation.id, token: invitation.token, target: { environmentId: (await target.controller.read()).environmentId, url: target.url }, secret: randomBytes(32).toString('base64url') }
  await expect(issuer.ctx.environmentPairing.redeem(changed)).rejects.toThrow('already redeemed')
  await expect(target.controller.pairingAccept(invitation, { ...grants, sessionAccess: false })).rejects.toThrow('changed')
})

it('binds a generated code to the first client and refuses a second client', async () => {
  const { issuer, target, invitation } = await pair()
  const other = await pairingHost((close) => { closes.push(close) })
  await target.controller.pairingAccept(invitation, grants)
  await expect(other.controller.pairingAccept(invitation, grants)).rejects.toThrow('refused')
  expect((await other.controller.read()).config.peers).toEqual([])
  expect((await issuer.controller.read()).config.peers).toEqual([
    expect.objectContaining({ environmentId: (await target.controller.read()).environmentId }),
  ])
})

it('accepts an existing invitation pinned to this client', async () => {
  const { issuer, target, invitation } = await pair()
  const destination = { environmentId: (await target.controller.read()).environmentId, url: target.url }
  const table = issuer.domain.table('invitations')
  const record = table.get(invitation.id)
  if (!record) throw new Error('Missing invitation')
  await table.put(invitation.id, { ...record, target: destination })
  await target.controller.pairingImport(JSON.stringify({ ...invitation, target: destination }), grants)
  expect((await issuer.controller.read()).config.peers[0]?.environmentId).toBe(destination.environmentId)
  expect((await target.controller.read()).config.peers[0]?.environmentId).toBe(invitation.issuer.environmentId)
})

it('rejects malformed and tampered codes without creating peer connections', async () => {
  const { issuer, target, invitation } = await pair()
  await expect(target.controller.pairingImport('dsh-pair:not-a-code', grants)).rejects.toThrow()
  const { config } = await target.controller.read()
  await expect(target.controller.pairingImport('x'.repeat(config.maxBytes + 1), grants)).rejects.toThrow('too large')
  const changed = { ...invitation, token: randomBytes(32).toString('base64url') }
  await expect(target.controller.pairingImport(`dsh-pair:${Buffer.from(JSON.stringify(changed)).toString('base64url')}`, grants)).rejects.toThrow('refused')
  expect((await issuer.controller.read()).config.peers).toEqual([])
  expect((await target.controller.read()).config.peers).toEqual([])
  expect((await issuer.controller.pairingList())[0]?.status).toBe('pending')
})

it('enforces issuer expiration even when the pasted code extends its expiry', async () => {
  const { issuer, target, invitation } = await pair()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(invitation.expiresAt)
  try {
    await expect(target.controller.pairingAccept({ ...invitation, expiresAt: invitation.expiresAt + 60_000 }, grants)).rejects.toThrow('refused')
    expect((await issuer.controller.read()).config.peers).toEqual([])
    expect((await target.controller.read()).config.peers).toEqual([])
    expect((await issuer.controller.pairingList())[0]?.status).toBe('expired')
  } finally { clock.mockRestore() }
})

it('rejects revoked, expired, misdirected, and over-limit invitations without broadening grants', async () => {
  const { issuer, target, invitation } = await pair()
  await expect(target.controller.pairingAccept({ ...invitation, target: invitation.issuer }, grants)).rejects.toThrow('another installation')
  await expect(issuer.controller.pairingCreate({ ...grants, workspaces: ['missing'] })).rejects.toThrow('unavailable workspace')
  const current = await issuer.controller.read()
  await issuer.controller.save({ ...current, config: { ...current.config, maxInvitations: 1 } })
  await expect(issuer.controller.pairingCreate(grants)).rejects.toThrow('limit')
  await issuer.controller.pairingRevoke(invitation.id)
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('refused')
  vi.spyOn(Date, 'now').mockReturnValue(invitation.expiresAt + 1)
  await expect(target.controller.pairingAccept({ ...invitation, id: brandString<typeof invitation.id>(randomUUID()) }, grants)).rejects.toThrow('expired')
})

it('stages credential replacement only for a current configuration revision', async () => {
  const host = await pairingHost((close) => { closes.push(close) })
  const current = await host.controller.read()
  const peerId = brandString<typeof current.environmentId>(randomUUID())
  const secret = randomBytes(32).toString('base64url')
  const saved = await host.controller.saveWithCredentials({ ...current, config: { ...current.config, peers: [{ environmentId: peerId, url: 'https://peer.example', tokenEnv: 'UNUSED', workspaces: [] }] } }, [{ environmentId: peerId, secret }])
  const peer = saved.config.peers[0]
  if (!peer) throw new Error('Missing saved peer')
  const set = vi.spyOn(host.ctx.credentials, 'set')
  await expect(host.controller.saveWithCredentials(current, [{ environmentId: peerId, secret: randomBytes(32).toString('base64url') }])).rejects.toThrow('Configuration changed')
  expect(set).not.toHaveBeenCalled()
  expect((await host.ctx.credentials.resolve(credentialRef(peer.tokenEnv)))?.value).toBe(secret)
  const rejected = vi.spyOn(host.ctx.configEditor, 'edit').mockRejectedValueOnce(new Error('profile conflict'))
  await expect(host.controller.saveWithCredentials(saved, [{ environmentId: peerId, secret: randomBytes(32).toString('base64url') }])).rejects.toThrow('profile conflict')
  expect((await host.ctx.credentials.resolve(credentialRef(peer.tokenEnv)))?.value).toBe(secret)
  expect(await host.controller.read()).toEqual(saved)
  rejected.mockRestore()
})


it.each(['issuer', 'target'] as const)('does not restore a removed peer after the %s receipt write fails', async (side) => {
  const { issuer, target, invitation } = await pair()
  if (side === 'issuer') {
    const table = issuer.domain.table('invitations')
    const put = table.put.bind(table)
    vi.spyOn(table, 'put').mockImplementation((id, value) => value.status === 'consumed'
      ? Promise.reject(new Error('receipt persistence failed')) : put(id, value))
  } else {
    const table = target.domain.table('attempts')
    const put = table.put.bind(table)
    vi.spyOn(table, 'put').mockImplementation((id, value) => value.status === 'complete'
      ? Promise.reject(new Error('receipt persistence failed')) : put(id, value))
  }
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow()
  const host = side === 'issuer' ? issuer : target
  const current = await host.controller.read()
  expect(current.config.peers).toHaveLength(1)
  await host.controller.save({ ...current, config: { ...current.config, peers: [] } })
  vi.restoreAllMocks()
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow()
  expect((await host.controller.read()).config.peers).toHaveLength(0)
})

it('refuses missing completed credentials and abandons disconnected staged attempts', async () => {
  const { issuer, target, invitation } = await pair()
  await target.controller.pairingAccept(invitation, grants)
  const current = await target.controller.read()
  const peer = current.config.peers[0]
  if (!peer) throw new Error('Missing target peer')
  await expect(target.controller.pairingForget(invitation.id)).rejects.toThrow('Remove the configured peer')
  await target.ctx.credentials.unset(credentialRef(peer.tokenEnv))
  await expect(target.controller.pairingAccept(invitation, grants)).rejects.toThrow('revoked or rotated')
  await target.controller.save({ ...current, config: { ...current.config, peers: [] } })
  expect(await target.controller.pairingAttempts()).toEqual([expect.objectContaining({ id: invitation.id, status: 'complete' })])
  await target.controller.pairingForget(invitation.id)
  expect(await target.controller.pairingAttempts()).toEqual([])
  await expect(issuer.controller.pairingRevoke(invitation.id)).rejects.toThrow('Remove the configured peer')
})
