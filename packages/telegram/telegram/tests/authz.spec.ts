import { describe, expect, it } from 'vitest'
import { AuthzGate } from '../src/authz.ts'
import type { Update } from '../src/types.ts'

function updateFrom(chatId: number, userId: number | undefined): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId },
      ...userId !== undefined ? { from: { id: userId, is_bot: false, first_name: 'u' } } : {},
      text: 'hello',
    },
  }
}

describe('AuthzGate', () => {
  it('drops updates without a chat or sender', () => {
    const gate = new AuthzGate([1], [2])
    expect(gate.allow({ update_id: 1, callback_query: { id: 'c', from: { id: 2, is_bot: false } } }).allowed).toBe(false)
    expect(gate.allow(updateFrom(1, undefined)).allowed).toBe(false)
  })

  it('requires both allowlisted chat and user when both lists are configured', () => {
    const gate = new AuthzGate([10], [20])
    expect(gate.allow(updateFrom(10, 20)).allowed).toBe(true)
    expect(gate.allow(updateFrom(11, 20)).allowed).toBe(false)
    expect(gate.allow(updateFrom(10, 21)).allowed).toBe(false)
  })

  it('stays chat-agnostic with an empty chat list and user-agnostic with an empty user list', () => {
    const chatOnly = new AuthzGate([10], [])
    expect(chatOnly.allow(updateFrom(10, 99)).allowed).toBe(true)
    expect(chatOnly.allow(updateFrom(11, 99)).allowed).toBe(false)
    const userOnly = new AuthzGate([], [20])
    expect(userOnly.allow(updateFrom(99, 20)).allowed).toBe(true)
    expect(userOnly.allow(updateFrom(99, 21)).allowed).toBe(false)
  })

  it('names the drop reason without content', () => {
    const gate = new AuthzGate([10], [])
    const decision = gate.allow(updateFrom(11, 5))
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('11')
    expect(decision.reason).not.toContain('hello')
  })
})
