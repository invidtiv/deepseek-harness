/** Session access requires an explicit grant and bounded refresh configuration. */
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

const input = {
  stateDirectory: resolve('state'), label: 'test', provider: 'test', model: 'test',
  agentPreset: 'standard', sandboxMode: 'read-only', approvalPolicy: 'ask',
  workspaces: { project: resolve('project') },
  peers: [{ environmentId: '11111111-1111-4111-8111-111111111111', url: 'https://peer.example', tokenEnv: 'PAIR', workspaces: ['project'], workspaceManagement: true }],
}

it('does not grant Session access when directory management is enabled', () => {
  expect(resolveConfig(input).peers[0]?.sessionAccess).toBe(false)
  expect(resolveConfig({ ...input,
    peers: [{ ...input.peers[0], sessionAccess: true, teamAccess: false, teamOperate: false }] }).peers[0]?.sessionAccess).toBe(true)
})

it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 2147483648])('rejects an unusable refresh interval %s', (sessionSyncIntervalMs) => {
  expect(() => resolveConfig({ ...input, sessionSyncIntervalMs })).toThrow()
})

it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('rejects an unusable Session result limit %s', (sessionPageSize) => {
  expect(() => resolveConfig({ ...input, sessionPageSize })).toThrow()
})

it('requires the peer idle deadline to allow a heartbeat', () => {
  expect(resolveConfig(input)).toMatchObject({ sessionStreamHeartbeatMs: 2000, sessionStreamIdleTimeoutMs: 10000 })
  const configured = resolveConfig({ ...input, sessionStreamHeartbeatMs: 100, sessionStreamIdleTimeoutMs: 500 })
  expect(configured).toMatchObject({ sessionStreamHeartbeatMs: 100, sessionStreamIdleTimeoutMs: 500 })
  for (const sessionStreamIdleTimeoutMs of [99, 100]) {
    expect(() => resolveConfig({ ...input, sessionStreamHeartbeatMs: 100, sessionStreamIdleTimeoutMs })).toThrow('heartbeat')
  }
})

it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 2147483648])('rejects an unusable stream deadline %s', (invalid) => {
  expect(() => resolveConfig({ ...input, sessionStreamHeartbeatMs: invalid })).toThrow()
  expect(() => resolveConfig({ ...input, sessionStreamIdleTimeoutMs: invalid })).toThrow()
})
