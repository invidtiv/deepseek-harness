import { describe, expect, it } from 'vitest'
import { AuthzGate } from '../src/authz.ts'
import type { Update } from '../src/types.ts'

describe('AuthzGate carriers', () => {
  it('reads the chat and sender of an edited message', () => {
    const gate = new AuthzGate([10], [20])
    const edited: Update = {
      update_id: 1,
      edited_message: {
        message_id: 1,
        chat: { id: 10 },
        from: { id: 20, is_bot: false, first_name: 'u' },
        text: 'fixed typo',
      },
    }
    const anonymous: Update = {
      update_id: 2,
      edited_message: { message_id: 1, chat: { id: 10 }, text: 'fixed typo' },
    }
    expect(gate.allow(edited).allowed).toBe(true)
    expect(gate.allow(anonymous).reason).toContain('carries no sender id')
  })

  it('drops an update whose sender carrier cannot be read', () => {
    // The chat id and the sender id are resolved by separate reads of the
    // update; a carrier that answers only the first leaves no sender to
    // authorize, which must drop rather than throw.
    let reads = 0
    const vanishing = {
      update_id: 1,
      get callback_query() {
        reads += 1
        // The chat lookup reads the carrier twice; the sender lookup follows.
        return reads <= 2
          ? { id: 'cb', from: { id: 20, is_bot: false }, message: { message_id: 1, chat: { id: 10 } } }
          : undefined
      },
    } as unknown as Update
    const decision = new AuthzGate([10], [20]).allow(vanishing)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('update from chat 10 carries no sender id')
  })
})
