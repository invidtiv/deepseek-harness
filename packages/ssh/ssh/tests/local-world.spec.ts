/**
 * The mixed deployment's local world: the local providers register their
 * execution-seam services in their own realms and are published under the
 * names the SSH providers fall back to, and unloading the entry takes them out
 * again.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as localWorld from '../src/local-world.ts'

/** The shared file-effect policy each local provider resolves. */
class Policy extends Service {
  readonly defaultMode = 'read-only'
  constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
  resolve(): { mode: 'read-only'; workspaceRoot: string } {
    return { mode: 'read-only', workspaceRoot: '/' }
  }
}

describe('local execution world', () => {
  it('publishes the local providers and removes them with its fiber', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Policy)

    const fiber = ctx.plugin(localWorld)
    await fiber

    expect(ctx.get('localFs', false)).toBeDefined()
    expect(ctx.get('localSubprocess', false)).toBeDefined()
    expect(ctx.get('localSandbox', false)).toBeDefined()

    await fiber.dispose()

    expect(ctx.get('localFs', false)).toBeUndefined()
    expect(ctx.get('localSubprocess', false)).toBeUndefined()
    expect(ctx.get('localSandbox', false)).toBeUndefined()
  })
})
