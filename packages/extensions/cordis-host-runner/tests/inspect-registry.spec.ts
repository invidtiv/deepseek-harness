import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { HostCordisInspectProviderRegistration } from '../src/inspect-registry.ts'

/**
 * Every per-session mount of the self-referential toolset registers the same
 * process-global provider ids, so identical manifests must share one entry and
 * survive until the last mount releases it.
 */

function provider(id: string, description: string = `${id} provider`): HostCordisInspectProviderRegistration {
  return {
    manifest: {
      id,
      description,
      methods: [{
        name: 'read',
        description: `Read ${id}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'string' },
      }],
    },
    async query(method) {
      if (method !== 'read') throw new Error(`unknown ${id} inspect method "${method}"`)
      return `${id} answer`
    },
  }
}

async function mountRegistry(): Promise<CordisInspectRegistryService> {
  const ctx = new Context()
  await ctx.plugin(CordisInspectRegistryService)
  return ctx.cordisInspect
}

describe('CordisInspectRegistryService provider registration', () => {
  it('shares one entry across identical registrations and removes it with the last holder', async () => {
    const registry = await mountRegistry()
    const first = registry.register(provider('Service'))
    const second = registry.register(provider('Service'))

    expect(registry.list().map(entry => entry.id)).toEqual(['Service'])

    first()
    expect(registry.list().map(entry => entry.id)).toEqual(['Service'])

    first()
    expect(registry.list().map(entry => entry.id)).toEqual(['Service'])

    second()
    expect(registry.list()).toEqual([])
  })

  it('rejects a different manifest under a held provider id', async () => {
    const registry = await mountRegistry()
    registry.register(provider('Event'))

    expect(() => registry.register(provider('Event', 'a different Event provider')))
      .toThrow('Host Cordis inspect provider "Event" is already registered with a different manifest')
  })

  it('accepts a fresh registration once every holder has released its reference', async () => {
    const registry = await mountRegistry()
    const release = registry.register(provider('Tool'))
    release()
    expect(registry.list()).toEqual([])

    registry.register(provider('Tool'))
    expect(registry.list().map(entry => entry.id)).toEqual(['Tool'])
  })
})
