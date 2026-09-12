// The peer family is product-visible, so a hand-built `ctx.plugin(...)` suite is
// not enough: this boots a test-only cordis.yml through the real Loader, mounts
// the seam, the Remote transport, and the tool consumer together, and drives one
// `peer_ask` against a fake peer Harness over HTTP.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import PeerService from '@deepseek-ai/dsh-peer'
import * as PeerRemote from '@deepseek-ai/dsh-peer-remote'
import * as ToolPeer from '@deepseek-ai/dsh-tool-peer'

/** Credential reference the composition names; the launch environment supplies its value. */
const COOKIE_ENV = 'DSH_PEER_LOADER_COOKIE'
const COOKIE_VALUE = 'dsh_session=loader-session'

/** One accepted Remote call, as the composed transport sent it. */
interface PeerCall {
  readonly endpoint: string
  readonly args: Record<string, unknown>
  readonly cookie: string | undefined
}

interface FakePeer {
  readonly baseUrl: string
  readonly calls: PeerCall[]
  close(): Promise<void>
}

/** A fake peer Harness on an ephemeral port that completes exactly one ask turn. */
async function startFakePeer(): Promise<FakePeer> {
  const calls: PeerCall[] = []
  let cursor = 0

  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const endpoint = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/api\//u, '')
      const payload = envelope.payload as { args?: Record<string, unknown> } | undefined
      calls.push({ endpoint, args: payload?.args ?? {}, cookie: request.headers.cookie })
      const value: unknown = (() => {
        switch (endpoint) {
          case 'session/create':
            return { sessionId: 'loader-peer-1' }
          case 'session/list':
            return { items: [{ sessionId: 'loader-peer-1', projections: { asOfSeq: cursor } }] }
          case 'session/prompt':
            cursor = 2
            return {}
          case 'session/page':
            return {
              records: [
                {
                  seq: 1,
                  event: {
                    seq: 1,
                    type: 'assistant/message',
                    data: { message: { content: [{ type: 'text', text: 'loader composition answer' }] } },
                  },
                },
                { seq: 2, event: { seq: 2, type: 'turn/end', data: { reason: { kind: 'end' } } } },
              ],
            }
          default:
            throw new Error(`unexpected peer endpoint ${endpoint}`)
        }
      })()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
    })().catch(() => { response.destroy() })
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

let root: string | undefined
let context: Context | undefined
let peer: FakePeer | undefined
const previousCookie = process.env[COOKIE_ENV]

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await peer?.close()
  peer = undefined
  if (previousCookie === undefined) Reflect.deleteProperty(process.env, COOKIE_ENV)
  else process.env[COOKIE_ENV] = previousCookie
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('peer real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and answers one peer_ask from the composed transport', async () => {
    peer = await startFakePeer()
    process.env[COOKIE_ENV] = COOKIE_VALUE
    root = await mkdtemp(join(tmpdir(), 'dsh-peer-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-peer'",
      "- name: '@deepseek-ai/dsh-peer-remote'",
      '  config:',
      '    peerId: loader-peer',
      `    baseUrl: ${peer.baseUrl}`,
      `    cookieEnv: ${COOKIE_ENV}`,
      '    defaultCwd: /srv/loader',
      '    pollIntervalMs: 1',
      '    askTimeoutMs: 5000',
      "- name: '@deepseek-ai/dsh-tool-peer'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-peer', PeerService],
      ['@deepseek-ai/dsh-peer-remote', PeerRemote],
      ['@deepseek-ai/dsh-tool-peer', ToolPeer],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    expect(ctx.peers.list()).toEqual(['loader-peer'])
    expect(ctx.tools.get('peer_ask')).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-peer-ask'),
      name: 'peer_ask',
      arguments: { prompt: 'report the loader composition' },
    })

    expect(result.isError).toBe(false)
    expect(resultText(result)).toMatch(/loader composition answer\n\n\[end \| \d+\.\ds \| loader-peer-1\]$/u)

    const calls = peer.calls
    expect(calls.map(call => call.endpoint)).toEqual(['session/create', 'session/list', 'session/prompt', 'session/list', 'session/page'])
    expect(calls.every(call => call.cookie === COOKIE_VALUE)).toBe(true)
    expect(calls.find(call => call.endpoint === 'session/create')?.args).toEqual({ request: { cwd: '/srv/loader' } })
  }, 30_000)
})
